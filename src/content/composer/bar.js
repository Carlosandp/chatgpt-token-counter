/**
 * The usage bar: one row at the bottom of the composer card, and its hover tooltips. Knows nothing
 * about ChatGPT's markup: it only renders values and gets inserted wherever selectors.js says.
 *
 *   [ Today 0.8% · 12.3k / 1.5M (est.) ]  [ █░░░░░░░░░ ]  [ Draft ~1.2k tokens ]  [ Plus ▾ ]
 *
 * Two different metrics, never merged under one label:
 *   - Today (bar + left)  the daily figure main.js keeps: ~4 characters per token over the messages shown
 *                         today, as a share of the extension's approximate limit for the chosen plan.
 *                         Estimate over an approximate reference; OpenAI publishes neither number.
 *   - Draft (right)       what is typed now, counted with the o200k_base tokenizer (composer/tokens.js).
 * There is no session or weekly figure: ChatGPT does not expose one, so none is shown.
 *
 * Numbers live in Text nodes updated through `nodeValue` and the bar width is a style change, so
 * refreshing them while typing never triggers childList mutations (and never wakes our own observers).
 */
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const BAR_ATTR = 'data-gc-bar';
  const TIP_GAP = 8;
  const TIP_MARGIN = 10;
  const MOVE_WINDOW_MS = 10000;
  const MAX_MOVES = 30;
  const PLAN_LABELS = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro' };
  // A click on the bar must not reach the composer's own handlers (they would focus the editor and close our <select>).
  const KEEP_LOCAL = ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'];

  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  class Bar {
    /**
     * @param {(kind: 'daily' | 'draft') => Row[]} describe tooltip rows, requested on hover; Row = {k, v} | {note}
     * @param {(plan: string) => void} onPlanChange called when the user picks another plan
     */
    constructor(describe, onPlanChange) {
      this.describe = describe;
      this.tip = null;
      this.moves = 0;
      this.moveWindowStart = 0;

      // Daily (left)
      this.liveDot = node('span', 'gc-bar__live');
      this.liveDot.setAttribute('role', 'img');
      this.liveDot.setAttribute('aria-label', 'ChatGPT is generating');
      this.liveDot.hidden = true;
      this.pctNode = document.createTextNode('0.0%');
      this.usedNode = document.createTextNode('0 / 0');
      this.pct = node('span', 'gc-bar__pct');
      this.pct.append(this.pctNode);
      this.used = node('span', 'gc-bar__used');
      this.used.append(this.usedNode);
      this.dailyCell = node('span', 'gc-bar__cell gc-bar__cell--daily');
      this.dailyCell.append(
        this.liveDot,
        node('span', 'gc-bar__label', 'Today'),
        this.pct,
        node('span', 'gc-bar__sep', '·'),
        this.used,
        node('span', 'gc-bar__flag', '(est.)')
      );

      this.fill = node('span', 'gc-bar__fill');
      this.meter = node('span', 'gc-bar__meter');
      this.meter.setAttribute('role', 'meter');
      this.meter.setAttribute('aria-valuemin', '0');
      this.meter.setAttribute('aria-valuemax', '100');
      this.meter.setAttribute('aria-label', 'Estimated daily usage against the approximate plan reference');
      this.meter.append(this.fill);

      // Draft (right)
      this.draftNode = document.createTextNode('~0');
      const draftValue = node('span', 'gc-bar__value');
      draftValue.append(this.draftNode);
      this.draftFlag = node('span', 'gc-bar__flag', '(est.)');
      this.draftFlag.hidden = true; // only when the tokenizer is unavailable and chars/4 is used
      this.draftCell = node('span', 'gc-bar__cell gc-bar__cell--draft');
      this.draftCell.append(node('span', 'gc-bar__label', 'Draft'), draftValue, node('span', 'gc-bar__unit', 'tokens'), this.draftFlag);

      // Plan
      this.plan = node('select', 'gc-bar__plan');
      this.plan.setAttribute('aria-label', 'Plan used for the approximate daily reference');
      this.plan.title = 'Plan used for the approximate daily reference';
      for (const [value, label] of Object.entries(PLAN_LABELS)) {
        const option = node('option', '', label);
        option.value = value;
        this.plan.append(option);
      }
      this.plan.addEventListener('change', () => onPlanChange(this.plan.value));

      this.el = node('div', 'gc-bar gc-bar--empty');
      this.el.setAttribute(BAR_ATTR, '');
      this.el.setAttribute('role', 'group');
      this.el.setAttribute('aria-label', 'Token usage');
      this.el.dataset.state = 'ok';
      this.el.append(this.dailyCell, this.meter, this.draftCell, this.plan);
      for (const type of KEEP_LOCAL) this.el.addEventListener(type, (event) => event.stopPropagation());

      this._bindTip(this.dailyCell, 'daily');
      this._bindTip(this.meter, 'daily');
      this._bindTip(this.draftCell, 'draft');
    }

    /**
     * Puts the bar at `{ parent, before }`. Position matters, not just parent: React can insert
     * siblings after we mounted, which would leave the bar mid-card.
     */
    mount({ parent, before }) {
      const el = this.el;
      const ref = before && before.parentNode === parent ? before : null;
      const placed = el.parentElement === parent && (ref === el || el.nextElementSibling === ref);
      if (placed || !this._allowMove(el.isConnected)) return;

      this._hideTip();
      parent.insertBefore(el, ref);
    }

    /** Safety valve: if the page keeps re-ordering the card we stop fighting it (re-attaching stays allowed). */
    _allowMove(wasConnected) {
      const now = Date.now();
      if (now - this.moveWindowStart > MOVE_WINDOW_MS) {
        this.moveWindowStart = now;
        this.moves = 0;
      }
      this.moves += 1;
      return !wasConnected || this.moves <= MAX_MOVES;
    }

    detach() {
      if (!this.el.isConnected) return;
      this._hideTip();
      this.el.remove();
    }

    destroy() {
      this.detach();
      this.tip?.remove();
      this.tip = null;
    }

    /** Live count of the draft (`exact`: counted by the o200k_base tokenizer, not by the chars/4 fallback). */
    setDraft(tokens, exact) {
      const shown = GC.tokens.formatCount(tokens);
      this.draftNode.nodeValue = `~${shown}`;
      this.draftFlag.hidden = exact;
      this.el.classList.toggle('gc-bar--empty', tokens === 0);
      this.draftCell.setAttribute('aria-label', `Draft: about ${shown} input tokens${exact ? '' : ' (estimated)'}`);
    }

    /** @param {{tokens: number, limit: number, pct: number, ratio: number, plan: string, state: string, generating: boolean}} d */
    setDaily(d) {
      const { formatCount } = GC.tokens;
      const pct = d.pct.toFixed(1);
      this.pctNode.nodeValue = `${pct}%`;
      this.usedNode.nodeValue = `${formatCount(d.tokens)} / ${formatCount(d.limit)}`;
      this.fill.style.width = `${pct}%`;
      this.el.dataset.state = d.state;
      this.liveDot.hidden = !d.generating;
      if (this.plan.value !== d.plan) this.plan.value = d.plan;
      this.meter.setAttribute('aria-valuenow', pct);
      this.meter.setAttribute('aria-valuetext', `${pct}% of the approximate ${PLAN_LABELS[d.plan] || d.plan} daily reference`);
    }

    _bindTip(target, kind) {
      target.addEventListener('pointerenter', () => this._showTip(kind, target));
      target.addEventListener('pointerleave', () => this._hideTip());
    }

    _showTip(kind, target) {
      if (!this.el.isConnected) return;
      const rows = this.describe(kind);

      if (!this.tip) {
        this.tip = node('div', 'gc-tip');
        this.tip.setAttribute('role', 'tooltip');
        document.body.append(this.tip);
      }
      this.tip.replaceChildren(
        ...rows.map((row) => {
          if (row.note) return node('div', 'gc-tip__note', row.note);
          const line = node('div', 'gc-tip__row');
          line.append(node('span', 'gc-tip__k', row.k), node('span', 'gc-tip__v', row.v));
          return line;
        })
      );
      this.tip.classList.add('gc-tip--visible');

      const anchor = target.getBoundingClientRect();
      const tip = this.tip.getBoundingClientRect();
      const centered = anchor.left + anchor.width / 2 - tip.width / 2;
      const left = Math.min(Math.max(TIP_MARGIN, centered), window.innerWidth - tip.width - TIP_MARGIN);
      const above = anchor.top - tip.height - TIP_GAP;
      this.tip.style.left = `${left}px`;
      this.tip.style.top = `${above >= TIP_MARGIN ? above : anchor.bottom + TIP_GAP}px`;
    }

    _hideTip() {
      this.tip?.classList.remove('gc-tip--visible');
    }
  }

  GC.Bar = Bar;
  GC.BAR_ATTR = BAR_ATTR;
})();

/**
 * Controller: keeps one usage bar (daily estimate + live draft count + plan picker) inside ChatGPT's composer card.
 *
 * - One MutationObserver on <body> (childList only, coalesced to one pass per SYNC_MS) notices
 *   when React re-creates the composer and re-attaches the same bar element; it never
 *   creates a second one.
 * - One MutationObserver on the editor itself follows the draft, which also catches changes
 *   that fire no `input` event (ChatGPT clearing the box after sending, restoring a draft...).
 * - The body observer only sees added/removed nodes. A slow heartbeat (HEARTBEAT_MS, skipped while the
 *   tab is hidden) re-runs the same cheap check, which covers changes made only through attributes or
 *   classes (an editor that gets hidden or re-labelled) without observing attributes page-wide.
 * - Until the bar is in place a structure check runs on the next task instead of waiting SYNC_MS, so
 *   the bar shows up in the same frame as ChatGPT's editor; the SYNC_MS coalescing only applies after that.
 * - The daily figures are pushed by daily.js (fed by main.js) when they change; nothing is polled here.
 * - The o200k_base tokenizer (2 MB) is not a manifest content script: parsing it at page load would block
 *   the main thread while ChatGPT itself is starting. Once the bar is mounted and the page is idle, the
 *   service worker injects it into this same isolated world; until then the draft uses the chars/4 estimate
 *   (flagged as such), and it is recounted as soon as the tokenizer arrives.
 * - A per-page instance id is a defensive guard: the service worker injects this script into tabs that were
 *   already open when the extension was installed or updated, so an older instance can be in the page (or an
 *   orphan of a previous version). The older one notices it was superseded, or that its extension context is
 *   gone, and removes its bar and observers.
 */
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});
  const { tokens: T, selectors: S, Bar } = GC;

  const INSTANCE_ATTR = 'data-gc-composer';
  const SYNC_MS = 200; // structure checks (find editor, re-attach the bar)
  const COUNT_MS = 100; // draft recount while typing
  const HEARTBEAT_MS = 2000; // safety net for attribute-only DOM changes
  const TOKENIZER_IDLE_TIMEOUT_MS = 2000; // upper bound for "when the page is idle", not a wait
  const LOAD_TOKENIZER = 'gc:load-tokenizer'; // message understood by background.js

  /** False once the extension was reloaded, updated or removed: this copy of the script is an orphan. */
  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const whenIdle = (fn) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: TOKENIZER_IDLE_TIMEOUT_MS }) : setTimeout(fn, 0);

  class ComposerCounter {
    constructor() {
      this.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      this.bar = new Bar((kind) => this._describe(kind), (plan) => GC.daily?.setPlan(plan));
      this.editor = null;
      this.editorObserver = null;
      this.bodyObserver = null;
      this.syncTimer = null;
      this.countTimer = null;
      this.heartbeat = null;
      this.lastDraft = null;
      this.lastPath = location.pathname;
      this.draft = { tokens: 0, chars: 0, exact: true };
      this.daily = GC.daily?.snapshot() ?? null;
      this.unsubscribe = null;
      this.tokenizerRequested = false;
      this.stopped = false;

      this._onNavigate = () => this._scheduleSync();
    }

    start() {
      document.documentElement.setAttribute(INSTANCE_ATTR, this.id);
      // Anything left by an older instance of this script in the same page.
      document.querySelectorAll(`[${GC.BAR_ATTR}]`).forEach((el) => el !== this.bar.el && el.remove());

      this.bodyObserver = new MutationObserver(() => this._scheduleSync());
      this.bodyObserver.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('popstate', this._onNavigate);
      window.addEventListener('pageshow', this._onNavigate);
      this.heartbeat = setInterval(() => !document.hidden && this._scheduleSync(), HEARTBEAT_MS);

      this.unsubscribe = GC.daily?.subscribe((snapshot) => this._setDaily(snapshot)) ?? null;
      if (this.daily) this.bar.setDaily(this.daily);

      this._sync();
    }

    stop() {
      this.stopped = true;
      this.bodyObserver?.disconnect();
      this.editorObserver?.disconnect();
      clearTimeout(this.syncTimer);
      clearTimeout(this.countTimer);
      clearInterval(this.heartbeat);
      this.unsubscribe?.();
      window.removeEventListener('popstate', this._onNavigate);
      window.removeEventListener('pageshow', this._onNavigate);
      this.bar.destroy();
    }

    _isCurrent() {
      return document.documentElement.getAttribute(INSTANCE_ATTR) === this.id;
    }

    _scheduleSync() {
      if (this.syncTimer === null) this.syncTimer = setTimeout(() => this._sync(), this.bar.el.isConnected ? SYNC_MS : 0);
    }

    _scheduleCount() {
      if (this.countTimer === null) this.countTimer = setTimeout(() => this._count(), COUNT_MS);
    }

    _sync() {
      this.syncTimer = null;
      if (!this._isCurrent() || !extensionAlive()) return this.stop();

      try {
        const editor = S.findEditor();
        const navigated = this.lastPath !== location.pathname;
        this.lastPath = location.pathname;

        if (editor !== this.editor) this._bindEditor(editor);
        else if (navigated) this._count();

        const anchor = editor && S.findAnchor(editor);
        if (anchor) {
          this.bar.mount(anchor);
          this._requestTokenizer();
        } else {
          this.bar.detach();
        }
        this._dropStrays();
      } catch {
        // The page is mid-render; the next mutation triggers another pass.
      }
    }

    /** Asks the service worker for the tokenizer once, after the bar is showing and the page is idle. */
    _requestTokenizer() {
      if (this.tokenizerRequested || T.hasTokenizer()) return;
      this.tokenizerRequested = true;
      whenIdle(() => {
        if (this.stopped || !extensionAlive()) return;
        chrome.runtime
          .sendMessage({ type: LOAD_TOKENIZER })
          .then((reply) => {
            if (!reply?.ok || this.stopped) return;
            this.lastDraft = null; // same text, better count
            this._count();
          })
          .catch(() => {
            // Service worker unreachable (extension reloading): keep the estimate; the next mount retries.
            this.tokenizerRequested = false;
          });
      });
    }

    /** At most one bar per page: drop copies (e.g. carried along when the page clones a subtree). */
    _dropStrays() {
      const bars = document.querySelectorAll(`[${GC.BAR_ATTR}]`);
      if (bars.length > 1) bars.forEach((el) => el !== this.bar.el && el.remove());
    }

    _bindEditor(editor) {
      this.editorObserver?.disconnect();
      this.editorObserver = null;
      this.editor = editor;
      this.lastDraft = null;

      if (editor) {
        this.editorObserver = new MutationObserver(() => this._scheduleCount());
        this.editorObserver.observe(editor, { childList: true, characterData: true, subtree: true });
      }
      this._count();
    }

    _count() {
      this.countTimer = null;
      const text = T.normalizeDraft(S.readDraft(this.editor));
      if (text === this.lastDraft) return;
      this.lastDraft = text;

      const { tokens, exact } = T.countTokens(text);
      this.draft = { tokens, chars: text.length, exact };
      this.bar.setDraft(tokens, exact);
    }

    _setDaily(snapshot) {
      this.daily = snapshot;
      this.bar.setDaily(snapshot);
    }

    /** Tooltip rows: `{k, v}` pairs and `{note}` lines. The two metrics are described separately on purpose. */
    _describe(kind) {
      const count = T.formatCount;
      if (kind === 'draft') {
        const { tokens, chars, exact } = this.draft;
        return [
          { k: 'Draft', v: `${exact ? '' : '~'}${count(tokens)} tokens` },
          { k: 'Characters', v: count(chars) },
          { k: 'Method', v: exact ? 'o200k_base' : `≈${T.CHARS_PER_TOKEN} chars/token` },
          {
            note: exact
              ? 'Exact for the o200k_base encoding; the model behind a chat may use another, so read it as an estimate. Excludes chat history, attachments and system instructions.'
              : 'Tokenizer unavailable, so this is a rough length-based estimate. Excludes chat history, attachments and system instructions.',
          },
        ];
      }

      const d = this.daily;
      if (!d) return [{ k: 'Today', v: 'not available' }];
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const rows = [
        { k: 'Today (est.)', v: `~${count(d.tokens)} tokens` },
        { k: 'Reference limit', v: `${d.plan[0].toUpperCase()}${d.plan.slice(1)} · ${count(d.limit)}/day` },
        { k: 'Share of reference', v: `${d.pct.toFixed(1)}%` },
        { k: 'Method', v: `≈${T.CHARS_PER_TOKEN} chars/token` },
        { k: 'Resets', v: `local midnight (in ${T.formatDuration(midnight - now)})` },
      ];
      if (d.model) rows.push({ k: 'Model (from page)', v: d.model });
      rows.push({
        note: 'Counts the messages shown in this browser today. The limit is this extension\'s own approximation for the plan: OpenAI does not publish daily token caps, so this is not your real quota. Not comparable with the draft count.',
      });
      return rows;
    }
  }

  function boot() {
    if (!document.body) return document.addEventListener('DOMContentLoaded', boot, { once: true });
    new ComposerCounter().start();
  }

  boot();
})();

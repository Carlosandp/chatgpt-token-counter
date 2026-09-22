// Daily usage state: the running total main.js counts, the plan chosen in the bar, and the model label
// read from the page. No DOM here: the composer bar (composer/index.js) subscribes and renders it.
//
// What the numbers are, kept explicit because they are easy to mistake for official ones:
//  - tokens  ESTIMATE: ~4 characters per token over the messages shown today (see main.js).
//  - limit   the extension's own approximate reference for the chosen plan (constants.js). OpenAI does
//            not publish daily token caps, so ratio/pct are "share of that reference", not of a real quota.
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const PLANS = ['free', 'go', 'plus', 'pro'];
  const DEFAULT_PLAN = 'plus';
  const FALLBACK_LIMIT = 360_000;

  function getState(ratio, plan) {
    const t = (GC.PLAN_THRESHOLDS && GC.PLAN_THRESHOLDS[plan]) || { warn: 0.60, danger: 0.85 };
    if (ratio > t.danger) return 'danger';
    if (ratio > t.warn)   return 'warn';
    return 'ok';
  }

  class DailyUsage {
    constructor() {
      this._tokens = 0;
      this._model = null;
      this._generating = false;
      this._plan = DEFAULT_PLAN;
      this._listeners = new Set();
    }

    initialize() {
      try {
        chrome.storage.local.get(['gc:plan'], (r) => {
          const plan = r?.['gc:plan'];
          if (PLANS.includes(plan) && plan !== this._plan) {
            this._plan = plan;
            this._emit();
          }
        });
      } catch {
        // Extension context invalidated: keep the default plan.
      }
    }

    /** Calls `listener(snapshot)` on every change; returns the unsubscribe function. */
    subscribe(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    snapshot() {
      const limit = GC.PLAN_LIMITS[this._plan] || FALLBACK_LIMIT;
      const ratio = Math.min(this._tokens / limit, 1);
      return {
        tokens: this._tokens,
        plan: this._plan,
        limit,
        ratio,
        pct: ratio * 100,
        state: getState(ratio, this._plan),
        model: this._model,
        generating: this._generating,
      };
    }

    setTokens(n) { if (n !== this._tokens) { this._tokens = n; this._emit(); } }
    setModel(slug) { if (slug && slug !== this._model) { this._model = slug; this._emit(); } }
    setGenerating(v) { if (v !== this._generating) { this._generating = v; this._emit(); } }

    setPlan(plan) {
      if (!PLANS.includes(plan) || plan === this._plan) return;
      this._plan = plan;
      try {
        if (chrome.runtime?.id) chrome.storage.local.set({ 'gc:plan': plan });
      } catch {
        // Not persisted this time; the choice still applies to this page.
      }
      this._emit();
    }

    _emit() {
      const snapshot = this.snapshot();
      for (const listener of this._listeners) {
        try { listener(snapshot); } catch { /* one broken subscriber must not stop the others */ }
      }
    }
  }

  GC.PLANS = PLANS;
  GC.DailyUsage = DailyUsage;
})();

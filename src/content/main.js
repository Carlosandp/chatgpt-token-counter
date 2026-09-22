// Daily usage tracker.
//
// Keeps one number: how many tokens have gone through the chats open in this browser since local
// midnight. It feeds daily.js, which the composer bar renders; nothing here touches the DOM of the bar.
//
// Method: ~4 characters per token over the text of the messages that appear on screen. This is a
// deliberately cheaper estimate than the draft counter in composer/tokens.js (which runs the real
// o200k_base encoding), and the reference limits in constants.js are calibrated against it, so the two
// figures are never added together or compared.
//
// What is and is not counted: only messages that show up *after* the tracker takes a baseline for the
// current chat. Whatever was already on screen when a chat opened is history, and history that scrolls
// into view later (ChatGPT loads older turns lazily) is history too. Both are ignored for good.
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const CHARS_PER_TOKEN = 4;
  const MESSAGE_SELECTOR = '[data-message-author-role]';
  const STREAMING_SELECTOR = '[data-testid="stop-button"], button[aria-label="Stop streaming"]';

  // A fresh chat needs a moment to render before its messages can be treated as history. The longer
  // delay after a navigation covers the second render ChatGPT does when it swaps conversations.
  const BASELINE_DELAY_MS = 1200;
  const BASELINE_DELAY_NAV_MS = 1400;
  const COUNT_DEBOUNCE_MS = 80;
  const LOCATION_POLL_MS = 500;

  const DAILY_PREFIX = 'gc:daily:';
  const LEGACY_PREFIX = 'gc:chat:'; // per-chat keys older versions wrote and never read back

  const daily = new GC.DailyUsage();
  GC.daily = daily; // the composer bar subscribes to this
  daily.initialize();

  // ── Reading the page ───────────────────────────────────────────────────────

  const estimateTokens = (text) => Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);

  const messagesOnScreen = () => Array.from(document.querySelectorAll(MESSAGE_SELECTOR));

  const isStreaming = () => document.querySelector(STREAMING_SELECTOR) !== null;

  // The model label is decoration: any short piece of text from the model switcher will do, and a miss
  // simply leaves the previous label in place.
  const MODEL_SELECTORS = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-haspopup="listbox"] span',
    'button[aria-haspopup="menu"] span',
    '[class*="model"] button span',
    'nav button span',
  ];

  function readModelLabel() {
    for (const selector of MODEL_SELECTORS) {
      const label = document.querySelector(selector)?.textContent?.trim();
      if (label && label.length < 40) return label;
    }
    return null;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** `gc:daily:2026-09-21` for the *local* calendar day (toISOString would roll over at UTC midnight). */
  function storageKeyForToday() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${DAILY_PREFIX}${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** Reads today's running total and drops every key that is no longer read. */
  function restoreTotal(onReady) {
    const key = storageKeyForToday();
    chrome.storage.local.get(null, (stored) => {
      const obsolete = Object.keys(stored).filter(
        (k) => (k.startsWith(DAILY_PREFIX) && k !== key) || k.startsWith(LEGACY_PREFIX)
      );
      if (obsolete.length) chrome.storage.local.remove(obsolete);
      onReady(stored[key] || 0);
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let total = 0;
  let storageKey = storageKeyForToday();
  let generating = false;

  // Counting is closed until the first baseline is taken. Without this, the mutations fired while the
  // page hydrates (and by the composer bar inserting itself) would count the visible history as new.
  let counting = false;

  // Messages that were already there when the baseline was taken, and how much each counted message has
  // contributed so far. Weak references: a turn removed from the DOM stops being tracked on its own
  // instead of pinning a detached subtree in memory for as long as the tab stays open.
  let history = new WeakSet();
  let counted = new WeakMap();

  let countTimer = null;

  function persist() {
    chrome.storage.local.set({ [storageKey]: total });
  }

  /** A tab left open past midnight starts the new day instead of adding to yesterday's total. */
  function rollOverIfNewDay() {
    const key = storageKeyForToday();
    if (key === storageKey) return;
    storageKey = key;
    total = 0;
    daily.setTokens(0);
    persist();
  }

  /** Marks everything currently on screen as history and starts counting what comes next. */
  function takeBaseline() {
    history = new WeakSet(messagesOnScreen());
    counted = new WeakMap();

    const model = readModelLabel();
    if (model) daily.setModel(model);

    counting = true;
  }

  function openChat(delayMs) {
    counting = false;
    setTimeout(takeBaseline, delayMs);
  }

  // ── Counting ───────────────────────────────────────────────────────────────

  /**
   * Adds whatever is new since the last pass. An assistant turn grows while it streams, so each message
   * contributes the difference against its own previous size; a message never subtracts.
   */
  function countNewText() {
    countTimer = null;
    if (!counting) return;
    rollOverIfNewDay();

    const model = readModelLabel();
    if (model) daily.setModel(model);

    let added = 0;
    for (const message of messagesOnScreen()) {
      if (history.has(message)) continue;

      const tokens = estimateTokens(message.innerText || message.textContent || '');
      const delta = tokens - (counted.get(message) || 0);
      if (delta <= 0) continue;

      counted.set(message, tokens);
      added += delta;
    }

    if (added === 0) return;
    total += added;
    daily.setTokens(total);
    persist();
  }

  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(countNewText, COUNT_DEBOUNCE_MS);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  restoreTotal((stored) => {
    storageKey = storageKeyForToday();
    total = stored;
    daily.setTokens(total);
    openChat(BASELINE_DELAY_MS);
  });

  new MutationObserver(() => {
    if (!counting) return;
    scheduleCount();

    const streaming = isStreaming();
    if (streaming === generating) return;
    generating = streaming;
    daily.setGenerating(streaming);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ChatGPT is a single-page app: switching conversations changes the URL without a load event, and the
  // new conversation's messages must become history rather than be counted as fresh usage.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      generating = false;
      daily.setGenerating(false);
      openChat(BASELINE_DELAY_NAV_MS);
    }
    rollOverIfNewDay();
  }, LOCATION_POLL_MS);
})();

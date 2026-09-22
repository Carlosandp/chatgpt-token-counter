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
// What is and is not counted: only the turn being produced now. Each message is classified the first
// time it is seen. It is new usage when a turn is live (ChatGPT is generating, or the user has just sent
// something) and it is the latest message of its role, i.e. the user's new prompt or the reply being
// streamed. Anything else is history and is ignored for good: the turns of a conversation that is being
// opened, older turns that ChatGPT loads lazily while scrolling, and messages React re-creates after a
// reply finishes.
//
// There is no fixed "baseline" delay. ChatGPT renders the turns of an existing conversation on the client,
// seconds after the page (measured: ~5.8 s after navigation on chatgpt.com, well after any delay a timer
// could guess), so a snapshot taken on a timer would count that history as today's usage.
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const CHARS_PER_TOKEN = 4;
  const MESSAGE_SELECTOR = '[data-message-author-role]';
  const STREAMING_SELECTOR = '[data-testid="stop-button"], button[aria-label="Stop streaming"]';
  const SEND_BUTTON_SELECTOR = '[data-testid="send-button"], #composer-submit-button, button.composer-submit-btn';
  const EDITOR_SELECTOR = '#prompt-textarea, [role="textbox"][contenteditable]';

  // At most one counting pass per this interval. A throttle, not a debounce: a reply streams without pauses,
  // and a debounce would postpone the first pass (and the classification of the new turn) until it ends.
  const COUNT_THROTTLE_MS = 200;
  const LOCATION_POLL_MS = 500;
  // A send whose turn never starts (an error, an empty box) must not leave the turn open forever: after
  // this long without ChatGPT generating, new messages are history again.
  const SEND_WINDOW_MS = 30000;

  const INSTANCE_ATTR = 'data-gc-daily';
  const instanceId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  const DAILY_PREFIX = 'gc:daily:';
  const LEGACY_PREFIX = 'gc:chat:'; // per-chat keys older versions wrote and never read back

  /** False once the extension was reloaded, updated or removed: this copy of the script is an orphan. */
  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

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

  // Nothing is added before today's stored total has been read, or the first write would overwrite it.
  let ready = false;

  // When the user last sent a prompt (0 = no send pending). See SEND_WINDOW_MS.
  let sentAt = 0;

  // Messages classified as history, and how much each counted message has contributed so far. Tracked by
  // element (weak references: a turn removed from the DOM stops being tracked on its own instead of pinning
  // a detached subtree in memory) and by ChatGPT's data-message-id, so that a turn React renders again as a
  // new element (when a reply finishes, or when a new chat moves to its /c/<id> URL) is recognised.
  const history = new WeakSet();
  const historyIds = new Set();
  const counted = new WeakMap();
  const countedIds = new Map();

  const messageId = (message) => message.getAttribute('data-message-id') || null;

  /** Tokens already added for this message, or undefined if it has never been counted. */
  function countedSoFar(message, id) {
    if (counted.has(message)) return counted.get(message);
    return id !== null ? countedIds.get(id) : undefined;
  }

  function markCounted(message, id, tokens) {
    counted.set(message, tokens);
    if (id !== null) countedIds.set(id, tokens);
  }

  function markHistory(message, id) {
    history.add(message);
    if (id !== null) historyIds.add(id);
  }

  let countTimer = null;
  let observer = null;
  let poll = null;

  function persist() {
    try {
      chrome.storage.local.set({ [storageKey]: total });
    } catch {
      // Extension context invalidated: the next check shuts this copy down.
    }
  }

  /**
   * Another copy of this script took over the page (the service worker injects one into tabs that were open
   * during an install or update), or this copy's extension context is gone. Either way it must stop
   * counting, or the same messages would be added twice or written through a dead context.
   */
  function superseded() {
    if (document.documentElement.getAttribute(INSTANCE_ATTR) === instanceId && extensionAlive()) return false;
    observer?.disconnect();
    clearInterval(poll);
    clearTimeout(countTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onClick, true);
    return true;
  }

  const turnIsLive = () => generating || (sentAt !== 0 && Date.now() - sentAt < SEND_WINDOW_MS);

  /** A tab left open past midnight starts the new day instead of adding to yesterday's total. */
  function rollOverIfNewDay() {
    const key = storageKeyForToday();
    if (key === storageKey) return;
    storageKey = key;
    total = 0;
    daily.setTokens(0);
    persist();
  }

  // ── Counting ───────────────────────────────────────────────────────────────

  /** The last message of each author role on screen: the only ones a live turn can be adding. */
  function latestByRole(messages) {
    const latest = new Map();
    for (const message of messages) latest.set(message.getAttribute('data-message-author-role'), message);
    return new Set(latest.values());
  }

  /**
   * Classifies messages seen for the first time and adds whatever is new since the last pass. An assistant
   * turn grows while it streams, so each message contributes the difference against its own previous size;
   * a message never subtracts.
   */
  function countNewText() {
    countTimer = null;
    if (!ready || superseded()) return;
    rollOverIfNewDay();

    const model = readModelLabel();
    if (model) daily.setModel(model);

    const messages = messagesOnScreen();
    const live = turnIsLive();
    const latest = live ? latestByRole(messages) : null;

    let added = 0;
    for (const message of messages) {
      const id = messageId(message);
      if (history.has(message) || (id !== null && historyIds.has(id))) continue;

      let before = countedSoFar(message, id);
      if (before === undefined) {
        if (!live || !latest.has(message)) {
          markHistory(message, id);
          continue;
        }
        before = 0;
      }

      const tokens = estimateTokens(message.innerText || message.textContent || '');
      const delta = tokens - before;
      if (delta <= 0) continue;

      markCounted(message, id, tokens);
      added += delta;
    }

    if (added === 0) return;
    total += added;
    daily.setTokens(total);
    persist();
  }

  function scheduleCount() {
    if (countTimer === null) countTimer = setTimeout(countNewText, COUNT_THROTTLE_MS);
  }

  function setGenerating(streaming) {
    if (streaming === generating) return;
    if (!streaming) {
      // Last pass while the turn is still live, so a message that appeared since the previous pass is
      // classified as part of it; after this, until the next send, new messages are history.
      clearTimeout(countTimer);
      countNewText();
      sentAt = 0;
    }
    generating = streaming;
    daily.setGenerating(streaming);
  }

  // ── Sends ──────────────────────────────────────────────────────────────────

  // The user's own prompt can reach the DOM a moment before the stop button does, so a send opens the turn
  // by itself. Capture phase: ChatGPT handles (and may stop) these events on the composer.
  const hasDraft = (editor) => (editor?.innerText || editor?.value || '').trim().length > 0;

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const editor = event.target instanceof Element ? event.target.closest(EDITOR_SELECTOR) : null;
    if (editor && hasDraft(editor)) sentAt = Date.now();
  }

  function onClick(event) {
    const button = event.target instanceof Element ? event.target.closest(SEND_BUTTON_SELECTOR) : null;
    if (button && !button.disabled) sentAt = Date.now();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  document.documentElement.setAttribute(INSTANCE_ATTR, instanceId);

  restoreTotal((stored) => {
    if (superseded()) return;
    storageKey = storageKeyForToday();
    total = stored;
    daily.setTokens(total);
    ready = true;
    // Whatever is on screen by now is classified (as history, unless a turn is already live).
    scheduleCount();
  });

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);

  observer = new MutationObserver(() => {
    if (superseded()) return;
    setGenerating(isStreaming());
    scheduleCount();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ChatGPT is a single-page app: switching conversations changes the URL without a load event. The new
  // conversation's turns need no special handling (they appear while no turn is live, so they are history);
  // only the generating marker is reset, in case the old page's stop button went away without a mutation.
  let lastHref = location.href;
  poll = setInterval(() => {
    if (superseded()) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      setGenerating(isStreaming());
    }
    rollOverIfNewDay();
  }, LOCATION_POLL_MS);
})();

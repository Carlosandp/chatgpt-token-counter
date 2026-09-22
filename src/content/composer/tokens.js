/**
 * Token counting and formatting for the in-composer counter (no DOM, no chrome.* calls).
 *
 * Three different claims, kept apart on purpose:
 *  - `exact: true`  the count is exactly what the vendored o200k_base encoding produces for the text.
 *  - Model fit      o200k_base is the encoding OpenAI documents for GPT-4o and the o-series; this code
 *                   cannot tell which model a chat uses, so it never asserts the count matches a model.
 *  - `exact: false` the tokenizer is missing or threw, so the count is a ~4 characters/token guess.
 * The bar therefore always shows "~" for the draft, and the tooltip states which of these applies.
 */
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const CHARS_PER_TOKEN = 4;
  // Text that merely *looks* like a special token (e.g. "<|endoftext|>") is ordinary text to ChatGPT.
  const PLAIN_TEXT = { disallowedSpecial: new Set() };

  /** What ChatGPT would actually send: no zero-width characters, no surrounding whitespace. */
  const normalizeDraft = (text) =>
    typeof text === 'string' ? text.replace(/\u200B/g, '').replace(/\r\n?/g, '\n').trim() : '';

  const estimateByChars = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

  const getTokenizer = () => globalThis.GPTTokenizer_o200k_base || null;

  /** Token count of `text` and whether it came from the real tokenizer or from the length heuristic. */
  function countTokens(text) {
    if (!text) return { tokens: 0, exact: true };
    const tokenizer = getTokenizer();
    if (tokenizer?.countTokens) {
      try {
        return { tokens: tokenizer.countTokens(text, PLAIN_TEXT), exact: true };
      } catch {
        // Fall through to the heuristic: a tokenizer hiccup must never blank the counter.
      }
    }
    return { tokens: estimateByChars(text), exact: false };
  }

  /** 842 -> "842", 12345 -> "12.3k", 2500000 -> "2.5M". */
  function formatCount(n) {
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n < 10000) return n.toLocaleString('en-US');
    if (n < 1e6) return `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}k`.replace('.0k', 'k');
    return `${(n / 1e6).toFixed(1)}M`.replace('.0M', 'M');
  }

  /** 17_000_000 ms -> "4h 43m"; under an hour -> "12m". Rounds up so a live countdown never shows 0m early. */
  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const minutes = Math.ceil(ms / 60000);
    const h = Math.floor(minutes / 60);
    return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
  }

  GC.tokens = { CHARS_PER_TOKEN, normalizeDraft, countTokens, formatCount, formatDuration };

  if (typeof module !== 'undefined' && module.exports) module.exports = GC.tokens;
})();

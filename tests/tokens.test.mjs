import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const TOKENS_JS = read('src/content/composer/tokens.js');
const VENDOR_JS = read('src/vendor/o200k_base.js');

/** Runs tokens.js like a content script; optionally after the vendored tokenizer (or a stub) is on globalThis. */
function load({ tokenizer = 'vendor' } = {}) {
  const module = { exports: {} };
  const sandbox = { module, Set, Number, Math, JSON, TextEncoder, TextDecoder };
  const context = vm.createContext(sandbox);
  if (tokenizer === 'vendor') vm.runInContext(VENDOR_JS, context);
  else if (tokenizer) sandbox.GPTTokenizer_o200k_base = tokenizer;
  vm.runInContext(TOKENS_JS, context);
  const plain = (fn) => (...args) => {
    const out = fn(...args);
    return out !== null && typeof out === 'object' ? JSON.parse(JSON.stringify(out)) : out;
  };
  return Object.fromEntries(Object.entries(module.exports).map(([k, v]) => [k, typeof v === 'function' ? plain(v) : v]));
}

const real = load();

test('with the vendored tokenizer the count is exact for o200k_base', () => {
  assert.deepEqual(real.countTokens('hello world'), { tokens: 2, exact: true });
  assert.deepEqual(real.countTokens('Hola Gemini, esto es una prueba de contador de tokens.'), { tokens: 12, exact: true });
});

test('empty text is exactly zero', () => {
  assert.deepEqual(real.countTokens(''), { tokens: 0, exact: true });
});

test('text that looks like a special token is counted as plain text, not an error', () => {
  const { tokens, exact } = real.countTokens('texto <|endoftext|> fin');
  assert.equal(exact, true);
  assert.equal(tokens, 9);
});

test('unicode, emoji and code do not fall back to the heuristic', () => {
  for (const text of ['Ünïcödé 日本語のテキスト 🚀', 'const x = [1, 2, 3].map((n) => n * 2);']) {
    assert.equal(real.countTokens(text).exact, true);
  }
});

test('without a tokenizer the count is the 4 chars/token estimate and is flagged as not exact', () => {
  const none = load({ tokenizer: null });
  assert.deepEqual(none.countTokens('a'.repeat(41)), { tokens: 11, exact: false });
});

test('a tokenizer that throws degrades to the estimate instead of blanking the counter', () => {
  const broken = load({ tokenizer: { countTokens: () => { throw new Error('boom'); } } });
  assert.deepEqual(broken.countTokens('a'.repeat(8)), { tokens: 2, exact: false });
});

test('the two methods are genuinely different: chars/4 is not o200k (do not present them as equivalent)', () => {
  const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item${i}`, tags: ['a', 'b'], ok: i % 2 === 0 })));
  const heuristic = Math.ceil(json.length / 4);
  const exact = real.countTokens(json).tokens;
  assert.ok(Math.abs(heuristic - exact) / exact > 0.2, `expected >20% divergence, got ${heuristic} vs ${exact}`);
});

test('normalizeDraft trims, drops zero-width characters and unifies line endings', () => {
  assert.equal(real.normalizeDraft('  hola​ mundo \n'), 'hola mundo');
  assert.equal(real.normalizeDraft('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(real.normalizeDraft(undefined), '');
});

test('formatCount is compact only for large values', () => {
  assert.equal(real.formatCount(27), '27');
  assert.equal(real.formatCount(9999), '9,999');
  assert.equal(real.formatCount(12345), '12.3k');
  assert.equal(real.formatCount(2500000), '2.5M');
  assert.equal(real.formatCount(NaN), '0');
});

test('formatDuration: rounds up to whole minutes, never shows 0m while time remains', () => {
  assert.equal(real.formatDuration(0), '0m');
  assert.equal(real.formatDuration(-5), '0m');
  assert.equal(real.formatDuration(NaN), '0m');
  assert.equal(real.formatDuration(1), '1m');
  assert.equal(real.formatDuration(59 * 60000), '59m');
  assert.equal(real.formatDuration(3600000), '1h 0m');
  assert.equal(real.formatDuration((4 * 60 + 43) * 60000), '4h 43m');
  assert.equal(real.formatDuration((4 * 60 + 42) * 60000 + 1), '4h 43m');
});

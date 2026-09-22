/**
 * Everything that knows what ChatGPT's DOM looks like lives here, so a markup change in ChatGPT
 * means editing this file only.
 *
 * Verified against chatgpt.com (React + ProseMirror):
 *   form[data-type="unified-composer"]
 *     [data-composer-surface]                                        <- the rounded card; grid "eyebrow / controls / body"
 *       [data-composer-controls-anchor]
 *       [data-composer-body]                                         (grid, template changes with the text height)
 *         [data-composer-transition-slot="leading"]                  (+ button)
 *         #prompt-textarea.ProseMirror[contenteditable][role=textbox]  <- the draft
 *         [data-composer-transition-slot="trailing"]                 (dictation, voice / send)
 *
 * The usage bar is a full-width row appended to the surface (see bar.css: `grid-row: -1`), i.e. inside the
 * card, below the body, whatever template the body is using.
 *
 * ChatGPT ships Tailwind utility classes, which are useless as hooks; the lookups below rely on
 * data-* attributes, ids and roles, with a structural heuristic (no attributes at all) as the last resort.
 */
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  const COMPOSER_ROOTS = 'form[data-type="unified-composer"], [data-composer-surface]';
  // Only the rich (contenteditable) editor. The server-rendered page shows a plain <textarea> inside the
  // same card until React hydrates, and React swaps it for #prompt-textarea in the hydration commit itself.
  // Anything added to that server markup is a hydration mismatch: React throws the whole composer away and
  // renders it again, taking the bar with it. The contenteditable editor only exists once React owns the
  // card, so it is also the signal that inserting the bar is safe.
  const EDITOR_SELECTORS = [
    '#prompt-textarea[contenteditable="true"]',
    '#prompt-textarea[contenteditable]', // ProseMirror sets "false" while the box is temporarily read-only
    '[role="textbox"][contenteditable="true"][aria-multiline="true"]',
    '[role="textbox"][contenteditable="true"]',
  ];
  const CARD = '[data-composer-surface]';
  const MAX_CLIMB = 12;
  const CARD_MIN_RADIUS = 12;

  const isVisible = (el) => el.isConnected && el.getClientRects().length > 0;

  const isUsableEditor = (el) => !el.disabled && isVisible(el);

  /** Prefers editors inside the unified composer (not the "edit message" box), then the lowest on screen. */
  function pickBest(candidates) {
    const inComposer = candidates.filter((el) => el.closest(COMPOSER_ROOTS));
    const pool = inComposer.length ? inComposer : candidates;
    return pool.reduce((best, el) => (el.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? el : best));
  }

  /** The prompt editor, or null when none is on screen (including before hydration, see EDITOR_SELECTORS). */
  function findEditor() {
    for (const selector of EDITOR_SELECTORS) {
      const matches = Array.from(document.querySelectorAll(selector)).filter(isUsableEditor);
      if (matches.length) return pickBest(matches);
    }
    return null;
  }

  /** Text currently typed in the editor (ProseMirror keeps one <p> per line; innerText restores the newlines). */
  function readDraft(editor) {
    if (!editor) return '';
    if (editor.matches('textarea, input')) return editor.value;
    return editor.innerText ?? editor.textContent ?? '';
  }

  /** Smallest ancestor of the editor that also holds the composer's buttons. */
  function findComposerRoot(editor) {
    const known = editor.closest(COMPOSER_ROOTS) || editor.closest('form');
    if (known) return known;
    let node = editor.parentElement;
    for (let depth = 0; node && node !== document.body && depth < MAX_CLIMB; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll('button').length >= 2) return node;
    }
    return null;
  }

  /**
   * A full-width row can only be added safely to a container that stacks its children (block, grid,
   * column flex, wrapping flex). A single-line flex row would put the bar beside the editor.
   */
  function stacksChildren(el) {
    const { display, flexDirection, flexWrap } = getComputedStyle(el);
    if (display.includes('grid')) return true;
    if (display.includes('flex')) return flexDirection.startsWith('column') || flexWrap !== 'nowrap';
    return display === 'block' || display === 'flow-root';
  }

  const childContaining = (parent, node) => Array.from(parent.children).find((child) => child.contains(node)) || null;

  /** The rounded, filled (or outlined) surface that visually is "the composer". */
  function findCard(editor, root) {
    for (let node = editor.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const filled = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
      const outlined = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none';
      const rounded = parseFloat(style.borderTopLeftRadius) >= CARD_MIN_RADIUS;
      if (rounded && (filled || outlined)) return node;
      if (node === root || node === document.body) break;
    }
    return null;
  }

  const endOf = (card) => (card && stacksChildren(card) ? { parent: card, before: null } : null);

  const slotAfter = (child) => (child?.parentElement && stacksChildren(child.parentElement) ? { parent: child.parentElement, before: child.nextElementSibling } : null);

  /** Attribute-free strategy: end of the card, going one level down while the card itself is not a stack. */
  function structuralSlot(root, editor) {
    const card = findCard(editor, root);
    if (!card) return null;
    if (stacksChildren(card)) return endOf(card);
    let host = childContaining(card, editor);
    while (host && !stacksChildren(host)) host = childContaining(host, editor);
    return host ? slotAfter(childContaining(host, editor)) : null;
  }

  const ANCHOR_STRATEGIES = [
    (root, editor) => endOf(editor.closest(CARD)),
    (root, editor) => structuralSlot(root, editor),
  ];

  /** Where the usage bar goes: `{ parent, before }` (insert `before` inside `parent`; null = last), or null. */
  function findAnchor(editor) {
    const root = findComposerRoot(editor);
    if (!root) return null;
    for (const strategy of ANCHOR_STRATEGIES) {
      try {
        const anchor = strategy(root, editor);
        if (anchor?.parent && root.contains(anchor.parent) && !editor.contains(anchor.parent)) return anchor;
      } catch {
        // A broken strategy must not stop the next one from running.
      }
    }
    return null;
  }

  GC.selectors = { findEditor, readDraft, findAnchor };
})();

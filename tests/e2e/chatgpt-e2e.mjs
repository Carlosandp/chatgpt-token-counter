import { launchChrome, loadExtension, openTab } from './cdp2.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const EXT = process.env.EXT || fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = []; const ok = (name, pass, detail = '') => { report.push({ name, pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail); };

// Reference tokenizer, loaded exactly like tests/tokens.test.mjs does, to compare the bar against.
const ctx = vm.createContext({ TextEncoder, TextDecoder, Set, Number, Math, JSON });
vm.runInContext(readFileSync(`${EXT}/src/vendor/o200k_base.js`, 'utf8'), ctx);
const o200k = (text) => ctx.GPTTokenizer_o200k_base.countTokens(text, { disallowedSpecial: new Set() });

// Output and fixtures resolve against this script, so the suite runs from any working directory.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = process.env.E2E_OUT || `${HERE}shots`;
mkdirSync(OUT, { recursive: true });
const html = readFileSync(`${HERE}chatgpt-replica.html`);
const b = await launchChrome();
const errors = [];
b.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('CONSOLE ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
});
try {
  await loadExtension(b, EXT);
  const t = await openTab(b, null);
  b.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== t.sessionId) return;
    const { requestId, request } = m.params;
    try {
      if (request.url.replace(/[?#].*/, '') === 'https://chatgpt.com/') await t.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: html.toString('base64') });
      else await t.send('Fetch.fulfillRequest', { requestId, responseCode: 204, body: '' });
    } catch {}
  });
  await t.send('Fetch.enable', { patterns: [{ urlPattern: 'https://chatgpt.com/*' }] });

  const shot = async (name, pad = 24) => {
    const clip = await t.evalJs(`(() => { const r = document.querySelector('[data-composer-surface]').getBoundingClientRect(); const x = Math.max(0, r.x - ${pad}), y = Math.max(0, r.y - ${pad}); return { x, y, width: Math.min(innerWidth - x, r.width + ${pad * 2}), height: r.height + ${pad * 2}, scale: 2 }; })()`);
    writeFileSync(`${OUT}/${name}.png`, Buffer.from((await t.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
  };
  const setViewport = (w, h = 900) => t.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  const state = () => t.evalJs(`(() => {
    const bars = [...document.querySelectorAll('[data-gc-bar]')]; const bar = bars[0]; const card = document.querySelector('[data-composer-surface]');
    if (!bar || !card) return { count: bars.length, card: !!card };
    const br = bar.getBoundingClientRect(), cr = card.getBoundingClientRect(), body = card.querySelector('[data-composer-body]').getBoundingClientRect();
    const btns = [...card.querySelectorAll('button, [role=button]')].filter(x => !bar.contains(x) && x.getClientRects().length).map(x => x.getBoundingClientRect());
    const overlap = btns.filter(x => x.left < br.right && x.right > br.left && x.top < br.bottom && x.bottom > br.top).length;
    const vis = [...bar.children].filter(c => getComputedStyle(c).display !== 'none').map(c => { const r = c.getBoundingClientRect(); return c.className.replace(/gc-bar__(cell--)?/, '') + '@' + Math.round(r.x) + ',' + Math.round(r.y) + '/' + Math.round(r.width); });
    return { count: bars.length, inCard: card.contains(bar), directChild: bar.parentElement === card, barRect: [br.x, br.y, br.width, br.height].map(Math.round), cardRect: [cr.x, cr.y, cr.width, cr.height].map(Math.round), belowBody: br.top >= body.bottom - 1, insideCard: br.bottom <= cr.bottom + 1 && br.left >= cr.left - 1 && br.right <= cr.right + 1, overlap, hOverflow: bar.scrollWidth > bar.clientWidth + 1, docHOverflow: document.documentElement.scrollWidth > innerWidth, vis,
      draft: bar.querySelector('.gc-bar__cell--draft .gc-bar__value').textContent, draftFlagHidden: bar.querySelector('.gc-bar__cell--draft .gc-bar__flag').hidden,
      pct: bar.querySelector('.gc-bar__pct').textContent, used: bar.querySelector('.gc-bar__used').textContent, fill: bar.querySelector('.gc-bar__fill').style.width, plan: bar.querySelector('.gc-bar__plan').value, dot: !bar.querySelector('.gc-bar__live').hidden, st: bar.dataset.state, natives: btns.length };
  })()`);
  const typeText = async (text) => { await t.evalJs(`(() => { const e = document.querySelector('#prompt-textarea'); e.replaceChildren(); const p = document.createElement('p'); e.append(p); e.dispatchEvent(new Event('input')); e.focus(); })()`); await t.send('Input.insertText', { text }); await sleep(450); };
  const reload = async () => { await t.send('Page.navigate', { url: 'https://chatgpt.com/' }); for (let i = 0; i < 40 && !(await t.evalJs(`!!document.querySelector('[data-gc-bar]')`)); i++) await sleep(300); await sleep(300); };

  await setViewport(1280); await reload();
  let s = await state();
  ok('bar appears once, as a direct child of the composer card, below the body, inside the card', s.count === 1 && s.directChild && s.belowBody && s.insideCard, JSON.stringify({ bar: s.barRect, card: s.cardRect }));
  ok('initial state: draft ~0, daily 0.0%, default plan Plus, no flags misleading', s.draft === '~0' && s.pct === '0.0%' && s.used === '0 / 1.5M' && s.plan === 'plus' && s.draftFlagHidden === true, JSON.stringify([s.draft, s.pct, s.used, s.plan]));
  ok('old floating strip is gone', await t.evalJs(`!document.querySelector('#gc-counter-bar')`));
  const nativeBefore = s.natives;
  await shot('chatgpt-desktop-dark-empty');

  // draft counting must equal the vendored o200k_base tokenizer exactly (unchanged algorithm)
  for (const [label, text] of [['plain', 'Hola ChatGPT, cuéntame algo breve sobre tokens.'], ['emoji+unicode', 'Ünïcödé 日本語のテキスト 🚀🚀 ✓'], ['special-token lookalike', 'texto <|endoftext|> fin'], ['code', 'const x = [1, 2, 3].map((n) => n * 2);']]) {
    await typeText(text); s = await state();
    const expected = o200k(text.trim());
    ok(`draft (${label}) equals o200k_base count (${expected})`, s.draft === `~${expected}` && s.draftFlagHidden === true, `${s.draft} vs ~${expected}`);
  }
  await typeText('Un texto largo para forzar el modo de varias lineas del compositor de ChatGPT y comprobar que la barra sigue debajo del cuerpo. '.repeat(2));
  s = await state();
  ok('multi-line body template: still one bar, below the body, no overlap with native buttons', s.count === 1 && s.directChild && s.belowBody && s.insideCard && s.overlap === 0, JSON.stringify({ bar: s.barRect, card: s.cardRect, overlap: s.overlap }));
  await shot('chatgpt-desktop-dark-multiline');
  await typeText('');

  // daily counter: wait for main.js to settle (1.2 s), then add messages (chars/4 estimate, unchanged logic)
  await sleep(1600);
  await t.evalJs(`window.__addMessage('assistant', 'x'.repeat(4000))`); await sleep(500);
  s = await state();
  ok('daily tokens = ceil(4000/4)=1000 of the 1.5M Plus reference (0.1%)', s.used === '1,000 / 1.5M' && s.pct === '0.1%', JSON.stringify([s.used, s.pct, s.fill]));
  // choose Free plan (36k reference) like a user would; add more so the state moves to "warn"
  await t.evalJs(`(() => { const sel = document.querySelector('.gc-bar__plan'); sel.value = 'free'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(300);
  s = await state();
  ok('plan selector works: Free -> limit 36k, share recomputed (1000/36000=2.8%)', s.plan === 'free' && s.used === '1,000 / 36k' && s.pct === '2.8%', JSON.stringify([s.plan, s.used, s.pct]));
  await t.evalJs(`window.__addMessage('assistant', 'y'.repeat(4 * 26100))`); await sleep(500);
  s = await state();
  ok('warn state colours the bar (27,100 / 36k = 75.3% -> above the 0.75 warn threshold)', s.st === 'warn' && s.used === '27.1k / 36k', JSON.stringify([s.st, s.used, s.pct, s.fill]));
  await shot('chatgpt-desktop-dark-warn');
  await t.evalJs(`window.__addMessage('assistant', 'z'.repeat(4 * 6000))`); await sleep(500);
  s = await state();
  ok('danger state (33,100/36k = 91.9% -> above the 0.917 danger threshold)', s.st === 'danger', JSON.stringify([s.st, s.used, s.pct]));
  // real click on the select: the composer's own click handlers must not see it; native button clicks still bubble
  const pos = await t.evalJs(`(() => { const r = document.querySelector('.gc-bar__plan').getBoundingClientRect(); const p = document.querySelector('#composer-plus-btn').getBoundingClientRect(); return { sel: [r.x + r.width / 2, r.y + r.height / 2], plus: [p.x + p.width / 2, p.y + p.height / 2] }; })()`);
  const click = async ([x, y]) => { await t.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await t.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  await t.evalJs(`window.__surfaceClicks = 0`);
  await click(pos.plus); const plusClicks = await t.evalJs(`window.__surfaceClicks`);   // positive control first
  await click(pos.sel); await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const selClicks = (await t.evalJs(`window.__surfaceClicks`)) - plusClicks;
  ok('click on the plan picker stays local (0) while a click on a native button still reaches the page (1)', selClicks === 0 && plusClicks === 1, `select=${selClicks} plus=${plusClicks}`);
  // plan persisted across reload (chrome.storage.local)
  await reload(); await sleep(400); s = await state();
  ok('plan choice persists across reload (chrome.storage)', s.plan === 'free', s.plan);

  // generating marker: static dot, appears with the stop button
  await t.evalJs(`window.__stream(true)`); await sleep(500);
  s = await state(); ok('generating marker shown while the stop button exists', s.dot === true);
  await t.evalJs(`window.__stream(false)`); await sleep(500);
  s = await state(); ok('generating marker hidden afterwards', s.dot === false);

  // resilience
  await t.evalJs(`window.__recreate()`); await sleep(900); s = await state();
  ok('composer re-created (React re-render) -> bar re-attached, exactly one, inside the new card', s.count === 1 && s.directChild && s.belowBody, JSON.stringify({ count: s.count, direct: s.directChild }));
  await t.evalJs(`document.querySelector('[data-gc-bar]').remove()`); await sleep(900);
  ok('bar removed by the page -> re-attached', (await state()).count === 1);
  await t.evalJs(`document.body.append(document.querySelector('[data-gc-bar]').cloneNode(true))`); await sleep(900);
  ok('stray duplicate removed (max one bar)', (await state()).count === 1);
  await t.evalJs(`history.pushState(null, '', '/c/abc123'); window.dispatchEvent(new PopStateEvent('popstate'))`); await sleep(1800);
  s = await state(); ok('SPA navigation keeps exactly one bar', s.count === 1 && s.directChild);
  ok('native buttons in the card unchanged (count)', s.natives === nativeBefore, `${s.natives} vs ${nativeBefore}`);
  const idle = await t.evalJs(`new Promise((res) => { let n = 0; const bar = document.querySelector('[data-gc-bar]'); const mo = new MutationObserver((l) => { n += l.filter(m => bar.contains(m.target) || m.target === bar.parentElement || [...m.addedNodes, ...m.removedNodes].includes(bar)).length; }); mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); setTimeout(() => { mo.disconnect(); res(n); }, 6000); })`);
  ok('idle for 6 s: zero mutations touching the bar (no render loop)', idle === 0, `mutations=${idle}`);

  // responsive + themes
  await t.evalJs(`window.__addMessage('assistant', 'w'.repeat(4 * 5000))`); await sleep(400);
  await typeText('Borrador de ejemplo para la captura de pantalla.');
  for (const w of [1280, 900, 700, 600, 520, 500, 420, 390, 380, 340, 320]) {
    await setViewport(w); await sleep(450); s = await state();
    ok(`width ${w}: one bar, inside card, no overlap, no overflow`, s.count === 1 && s.insideCard && s.overlap === 0 && !s.hOverflow && !s.docHOverflow, JSON.stringify({ card: s.cardRect, bar: s.barRect, vis: s.vis }));
    if ([1280, 600, 390, 380, 320].includes(w)) await shot(`chatgpt-w${w}-dark`);
  }
  await setViewport(1280); await t.evalJs(`window.__theme('light')`); await sleep(500); await shot('chatgpt-desktop-light');
  await setViewport(390); await sleep(500); await shot('chatgpt-w390-light'); await setViewport(380); await sleep(400); await shot('chatgpt-w380-light');
  await setViewport(1280); await sleep(300);
  for (const [sel, name] of [['.gc-bar__cell--daily', 'daily'], ['.gc-bar__cell--draft', 'draft']]) {
    const [x, y] = await t.evalJs(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    // A real pointer travels; a single teleporting mouseMoved makes Chrome emit the boundary events of the
    // zones it skipped in an order that leaves the tooltip hidden. Move in steps, like a hand does.
    const [fx, fy] = await t.evalJs(`(() => { const r = document.querySelector('.gc-bar').getBoundingClientRect(); return [r.x + 5, r.y + r.height / 2]; })()`);
    for (let i = 1; i <= 12; i += 1) {
      await t.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + ((x - fx) * i) / 12, y: fy + ((y - fy) * i) / 12 });
      await sleep(30);
    }
    await sleep(500);
    const tip = await t.evalJs(`(() => { const t = document.querySelector('.gc-tip'); return t && t.classList.contains('gc-tip--visible') ? t.innerText : null; })()`);
    ok(`tooltip (${name})`, !!tip, JSON.stringify(tip));
    if (name === 'daily') { const clip = await t.evalJs(`(() => { const r = document.querySelector('.gc-tip').getBoundingClientRect(), c = document.querySelector('[data-composer-surface]').getBoundingClientRect(); const y = Math.max(0, r.y - 10); return { x: Math.max(0, c.x - 20), y, width: c.width + 40, height: c.bottom + 20 - y, scale: 2 }; })()`); writeFileSync(`${OUT}/chatgpt-tooltip-daily.png`, Buffer.from((await t.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64')); }
  }
  const ours = errors.filter((e) => /chrome-extension|gc-|GPTCounter/.test(e));
  ok('no console errors from the extension', ours.length === 0, JSON.stringify(ours.slice(0, 4)));
  console.log('ALL ERRORS SEEN:', JSON.stringify(errors.slice(0, 5)));
} catch (e) { console.log('HARNESS ERROR', e.stack); }
b.kill();
writeFileSync(`${OUT}/chatgpt-e2e.json`, JSON.stringify(report, null, 1));
console.log(`\n${report.filter((r) => r.pass).length}/${report.length} passed`);

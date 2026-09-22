// CDP over --remote-debugging-pipe so Extensions.loadUnpacked works in branded Chrome (the
// --load-extension switch is ignored there). Throwaway profile; never touches a personal profile.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CHROME =
  process.env.CHROME ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome');

export async function launchChrome({ bin = DEFAULT_CHROME, width = 1300, height = 900 } = {}) {
  const profile = mkdtempSync(join(process.env.SCRATCH || tmpdir(), 'chrome-profile-'));
  const proc = spawn(bin, [
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const [toBrowser, fromBrowser] = [proc.stdio[3], proc.stdio[4]];
  let id = 0; const pending = new Map(); const listeners = []; let buf = '';
  fromBrowser.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i; while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else listeners.forEach((l) => l(msg));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; const timer = setTimeout(() => { pending.delete(i); rej(new Error('CDP timeout ' + method)); }, 20000); pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } }); toBrowser.write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
  return { proc, profile, send, on: (l) => listeners.push(l), kill: () => proc.kill('SIGKILL') };
}

export async function loadExtension(b, path) { return (await b.send('Extensions.loadUnpacked', { path })).id; }

export async function openTab(b, url) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => b.send(m, p, sessionId);
  await send('Page.enable'); await send('Runtime.enable');
  const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  if (url) await send('Page.navigate', { url });
  return { targetId, sessionId, send, evalJs };
}

// Service worker. Two jobs, both about getting the content scripts into the page at the right moment:
//
// 1. Tabs that were already open. Chrome only injects manifest content scripts into pages loaded after the
//    extension is installed or updated (and reloading an unpacked extension counts as an update). Without
//    this, a ChatGPT tab that was open at that moment shows no bar until the user reloads it. The scripts
//    detect an older copy of themselves in the page and take over from it (composer/index.js, main.js).
//
// 2. The o200k_base tokenizer. It is 2 MB of JavaScript, so it is not a manifest content script: the composer
//    asks for it once its bar is on screen and the page is idle, and it is injected into the same isolated
//    world as the content scripts, where composer/tokens.js picks it up.
'use strict';

const CONTENT = chrome.runtime.getManifest().content_scripts[0];
const TOKENIZER_FILE = 'src/vendor/o200k_base.js';
const LOAD_TOKENIZER = 'gc:load-tokenizer'; // sent by composer/index.js

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: CONTENT.matches });
  await Promise.all(
    tabs
      // A discarded tab reloads (and gets the manifest scripts) when it is selected again.
      .filter((tab) => tab.id !== undefined && !tab.discarded)
      .map(async (tab) => {
        const target = { tabId: tab.id };
        try {
          await chrome.scripting.insertCSS({ target, files: CONTENT.css });
          await chrome.scripting.executeScript({ target, files: CONTENT.js });
        } catch {
          // The tab navigated away, is showing an error page, or closed meanwhile: nothing to do.
        }
      })
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Not on a browser update ("chrome_update"): open tabs still run the current scripts then.
  if (reason === 'install' || reason === 'update') injectIntoOpenTabs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== LOAD_TOKENIZER || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
  chrome.scripting
    .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files: [TOKENIZER_FILE] })
    .then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
  return true; // the response is sent asynchronously
});

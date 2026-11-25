// Goal: the canvas frame tells the app when the dev server's error overlay comes up over its page and when it goes
// (electron/preload/frameErrorOverlay.ts), with the overlay's own words, bounded. The overlay is the only sign of an
// error the page's answer does not show (a stylesheet of a deleted <style> block, before the dev plugin left it out).
// Method: a jsdom canvas page (#avb-design) and the real module; the overlay is built the way Vite and Astro build it
// (a `vite-error-overlay` element with an open shadow root holding the message), appended to and removed from the
// body. Every message the frame posts is recorded and compared whole; a frame that is not the canvas posts nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule.js');

function page(hash) {
  const dom = new JSDOM('<!doctype html><html><body><main>Page</main></body></html>', { url: `http://127.0.0.1:4321/${hash}` });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.MutationObserver = dom.window.MutationObserver;
  const posted = [];
  const overlayModule = loadRenderer('electron/preload/frameErrorOverlay.ts');
  return { dom, document: dom.window.document, posted, overlayModule };
}

// The overlay as the dev server's client draws it: Astro's words in #message-content, its title in #title.
function overlay(document, message) {
  const element = document.createElement('vite-error-overlay');
  const root = element.attachShadow({ mode: 'open' });
  root.innerHTML = `<h1 id="title">An error occurred.</h1><div id="message-content">${message}</div>`;
  return element;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the overlay coming and going is told once each, with its words', async () => {
  const { document, posted, overlayModule } = page('#avb-design');
  overlayModule.reportErrorOverlay((message) => posted.push(message));
  assert.deepEqual(posted, [], 'a page without an overlay says nothing');
  const shown = overlay(document, 'No Astro CSS at index 0');
  document.body.append(shown);
  await flush();
  assert.deepEqual(posted, [{ type: 'avb:error-overlay', shown: true, message: 'No Astro CSS at index 0\nAn error occurred.' }]);
  document.body.append(document.createElement('div'));
  await flush();
  assert.equal(posted.length, 1, 'other changes to the body say nothing');
  shown.remove();
  await flush();
  assert.deepEqual(posted[1], { type: 'avb:error-overlay', shown: false, message: undefined });
  assert.equal(posted.length, 2);
});

test('the words are bounded, and an overlay without words is still an overlay', async () => {
  const { document, overlayModule } = page('#avb-design');
  const long = overlay(document, 'x'.repeat(5_000));
  document.body.append(long);
  assert.equal(overlayModule.overlayOf(document.body).message.length, overlayModule.ERROR_OVERLAY_LIMITS.messageCharsMax);
  long.remove();
  document.body.append(document.createElement('vite-error-overlay'));
  assert.deepEqual(overlayModule.overlayOf(document.body), { shown: true, message: undefined });
});

test('a frame that is not the canvas reports nothing', async () => {
  const { document, posted, overlayModule } = page('');
  overlayModule.reportErrorOverlay((message) => posted.push(message));
  document.body.append(overlay(document, 'No Astro CSS at index 0'));
  await flush();
  assert.deepEqual(posted, []);
});

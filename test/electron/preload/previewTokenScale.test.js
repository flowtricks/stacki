// Goal: the canvas frame announces a rendering's token for a page of any size
// and any number of stamps (owner requirement: no size limit), and gathers the
// stamps without freezing the page. Before, a page with more than 20 000 stamps,
// 512 files or 2 000 000 elements announced no token at all, so every click on
// it was refused as "still loading"; and the whole stamp walk ran in one block.
// Method: run the real built preload in jsdom as a canvas frame (as
// previewTokenFrame.test.js does) over a page with a hundred thousand elements,
// thousands of stamped files and tens of thousands of stamp comments (one per
// rendered copy), and check the announced token against the shared manifest
// code: nothing dropped, same digest. The announcement is measured with
// measureOperation: the walk works in slices and yields between them, so the
// loop's longest block must stay under the bound. (jsdom is far slower than a
// browser, so the bound here is the harder test.)
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { lagMsBound, measureOperation, scaleMegabytes } = require('../../helpers/scaleFixtures.ts');
const { canonicalManifest, manifestOf, stampComment } = require('#dist/shared/page/previewToken.js');

const FILES = 4000;
const COPIES_PER_FILE = 12;

const checksumOf = (index) => createHash('sha256').update(`file ${index}`).digest('hex');
const fileOf = (index) => `src/components/Component${String(index).padStart(5, '0')}.astro`;

function pageHtml(elements) {
  const parts = ['<!doctype html><html><body><main>'];
  let stamped = 0;
  for (let index = 0; index < elements; index++) {
    parts.push('<div class="n">x</div>');
    if (index % Math.floor(elements / (FILES * COPIES_PER_FILE)) === 0 && stamped < FILES * COPIES_PER_FILE) {
      const file = stamped % FILES;
      parts.push(stampComment({ file: fileOf(file), checksum: checksumOf(file) }));
      stamped++;
    }
  }
  parts.push('</main></body></html>');
  return parts.join('');
}

async function frame(html) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4321/#avb-design', pretendToBeVisual: true });
  const { window } = dom;
  const BOX = { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  window.Element.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getClientRects = () => [BOX];
  const sent = [];
  const globals = {
    window,
    document: window.document,
    location: window.location,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    Element: window.Element,
    HTMLStyleElement: window.HTMLStyleElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  window.parent = { postMessage: (message) => sent.push(message) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  const entry = repoPath('dist/electron/preload/preload.js');
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module.prototype.require = realRequire;
  }
  return { window, sent };
}

test('a page of a hundred thousand elements and thousands of stamps still gets its token', async (context) => {
  const elements = Math.max(FILES * COPIES_PER_FILE, Math.floor((scaleMegabytes() / 24) * 100_000));
  const { window, sent } = await frame(pageHtml(elements));
  context.after(() => window.close());
  const track = new window.MessageEvent('message', { data: { type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 } });
  Object.defineProperty(track, 'source', { value: window.parent });

  const announced = await measureOperation('frameToken', `elements=${elements} files=${FILES} stamps=${FILES * COPIES_PER_FILE}`, async () => {
    window.dispatchEvent(track);
    for (let waited = 0; waited < 600; waited++) {
      const message = sent.find((candidate) => candidate.type === 'avb:render' || candidate.type === 'avb:render-problem');
      if (message !== undefined) {
        return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the frame never announced a rendering');
  });
  assert.equal(announced.value.type, 'avb:render', `a token, not a problem (${JSON.stringify(announced.value).slice(0, 80)})`);
  const stamps = Array.from({ length: FILES }, (_, index) => ({ file: fileOf(index), checksum: checksumOf(index) }));
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok);
  assert.equal(announced.value.stamps.length, FILES, 'every stamped file is in the manifest, none dropped');
  assert.equal(announced.value.token, createHash('sha256').update(canonicalManifest(manifest.value)).digest('hex'), 'the token is the shared manifest digest');
  assert.ok(announced.lagMsMax < lagMsBound(), `the stamp walk yields: lag ${announced.lagMsMax} ms`);
});

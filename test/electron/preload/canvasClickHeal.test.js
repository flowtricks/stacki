// Goal: the canvas frame never goes deaf or vouches for the wrong page, the
// frame-side half of "a click on the canvas always does something"
// (docs/canvas-click.md). Each case is a page shape that left clicks refused or
// unheard before: a page whose markup arrives after the first look, page
// scripts that stop the pointer's events, Astro's <ClientRouter /> swapping the
// page in place, a rendering that mixes versions of one file, a forged stamp,
// and the editor's fresh look at a click it could not apply.
// Methodology: run the real built preload in jsdom as a tracked canvas frame,
// with the parent's postMessage captured and elementFromPoint pointed at the
// element under test (jsdom lays nothing out). Assertions read only what the
// frame posts, the same messages the editor parses.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { canonicalManifest, manifestOf, stampComment, parsePreviewRender } = require('#dist/shared/page/previewToken.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const page = { file: 'src/pages/index.astro', checksum: 'a'.repeat(64) };
const other = { file: 'src/pages/about.astro', checksum: 'c'.repeat(64) };

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
  await settle();
  const fromApp = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  fromApp({ type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 });
  await settle();
  const pointAt = (element) => {
    window.document.elementFromPoint = () => element;
  };
  return { window, sent, fromApp, pointAt };
}

function expectedToken(stamps) {
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok);
  return createHash('sha256').update(canonicalManifest(manifest.value)).digest('hex');
}

const of = (sent, type) => sent.filter((message) => message.type === type);

test('a page whose markup arrives after the first look still hears clicks', async () => {
  const { window, sent, pointAt } = await frame(`<!doctype html><html><body><main id="app"></main>${stampComment(page)}</body></html>`);
  // Client code (or the first patch) fills the page in after the frame started.
  window.document.getElementById('app').innerHTML = '<!--avb-s:0--><h1 id="title">Hello</h1><!--avb-e:0-->';
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  const title = window.document.getElementById('title');
  pointAt(title);
  title.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const click = of(sent, 'avb:click-node').at(-1);
  assert.ok(click, 'the click is reported');
  assert.equal(click.path, '0', 'and names the node that arrived late');
  assert.equal(click.token, of(sent, 'avb:render').at(-1).token, 'with the rendering it landed on');
});

test('a page that stops the pointer’s events cannot hide a hover', async () => {
  const { window, sent, pointAt } = await frame(
    `<!doctype html><html><body><!--avb-s:0--><div id="card"><!--avb-s:0.0--><p id="text">Words</p><!--avb-e:0.0--></div><!--avb-e:0-->${stampComment(page)}</body></html>`,
  );
  const text = window.document.getElementById('text');
  // A carousel or a modal library: stops mousemove everywhere it can.
  window.document.addEventListener('mousemove', (event) => event.stopImmediatePropagation(), true);
  text.addEventListener('mousemove', (event) => event.stopPropagation());
  pointAt(text);
  text.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
  const hover = of(sent, 'avb:hover-node').at(-1);
  assert.ok(hover, 'the hover is reported');
  assert.equal(hover.path, '0.0');
});

test('a ClientRouter swap re-reads the markers and the stamps', async () => {
  const { window, sent, pointAt } = await frame(
    `<!doctype html><html><body><!--avb-s:0--><p id="home">Home</p><!--avb-e:0-->${stampComment(page)}</body></html>`,
  );
  const first = of(sent, 'avb:render').at(-1);
  assert.equal(first.token, expectedToken([page]));
  // astro:transitions swaps the body in place; no document load happens.
  window.document.body.innerHTML = `<!--avb-s:0--><h2 id="about">About</h2><!--avb-e:0-->${stampComment(other)}`;
  window.document.dispatchEvent(new window.Event('astro:after-swap'));
  await settle();
  const second = of(sent, 'avb:render').at(-1);
  assert.equal(second.token, expectedToken([other]), 'the frame vouches for the page it now shows');
  const about = window.document.getElementById('about');
  pointAt(about);
  about.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const click = of(sent, 'avb:click-node').at(-1);
  assert.equal(click.path, '0');
  assert.equal(click.token, second.token);
});

test('a resting pointer is hit-tested again once a changed page vouches for itself', async () => {
  const { window, sent, pointAt } = await frame(
    `<!doctype html><html><body><!--avb-s:0--><p id="one">One</p><!--avb-e:0-->${stampComment(page)}</body></html>`,
  );
  const one = window.document.getElementById('one');
  pointAt(one);
  one.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
  const before = of(sent, 'avb:hover-node').length;
  for (const comment of [...window.document.body.childNodes].filter((node) => node.nodeType === 8 && node.data.startsWith('avb-d:'))) {
    comment.remove();
  }
  window.document.body.appendChild(window.document.createComment(stampComment({ ...page, checksum: 'b'.repeat(64) }).slice(4, -3)));
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  const rendered = of(sent, 'avb:render').at(-1);
  const hovers = of(sent, 'avb:hover-node');
  assert.ok(hovers.length > before, 'the hover is said again');
  assert.equal(hovers.at(-1).token, rendered.token, 'with the new rendering’s token, so the outline is drawn again');
  assert.equal(hovers.at(-1).path, '0');
});

test('the editor’s fresh look answers with the current token and never reaches the page', async () => {
  const { window, sent, fromApp, pointAt } = await frame(
    `<!doctype html><html><body><!--avb-s:0--><button id="buy">Buy</button><!--avb-e:0-->${stampComment(page)}</body></html>`,
  );
  let pageClicks = 0;
  const button = window.document.getElementById('buy');
  button.addEventListener('click', () => {
    pageClicks += 1;
  });
  pointAt(button);
  fromApp({ type: 'avb:click-query', id: 7, x: 5, y: 5 });
  const answer = of(sent, 'avb:click-node').at(-1);
  assert.ok(answer, 'the look is answered');
  assert.equal(answer.replay, 7, 'naming the look it answers');
  assert.equal(answer.path, '0');
  assert.equal(answer.token, of(sent, 'avb:render').at(-1).token);
  assert.equal(pageClicks, 0, 'a question is not a click');
  const count = of(sent, 'avb:click-node').length;
  for (const malformed of [
    { id: 0, x: 1, y: 1 },
    { id: 1.5, x: 1, y: 1 },
    { id: 2 ** 40, x: 1, y: 1 },
    { id: 3, x: Number.NaN, y: 1 },
    { id: 3, x: 1, y: 1e9 },
    { id: '3', x: 1, y: 1 },
  ]) {
    fromApp({ type: 'avb:click-query', ...malformed });
  }
  assert.equal(of(sent, 'avb:click-node').length, count, 'a malformed look is not answered');
});

test('a rendering mixing two versions of one file says so instead of falling silent', async () => {
  const { sent } = await frame(
    `<!doctype html><html><body><!--avb-s:0--><p>x</p><!--avb-e:0-->${stampComment(page)}${stampComment({ ...page, checksum: 'b'.repeat(64) })}</body></html>`,
  );
  assert.equal(of(sent, 'avb:render').length, 0, 'no token is vouched for');
  assert.deepEqual(of(sent, 'avb:render-problem').at(-1), { type: 'avb:render-problem', problem: 'conflicting-stamps' });
});

test('a forged stamp is skipped, not fatal to the whole rendering', async () => {
  const forged = `<!--avb-d:${'d'.repeat(64)}:../outside.astro-->`;
  const { sent } = await frame(`<!doctype html><html><body><!--avb-s:0--><p>x</p><!--avb-e:0-->${forged}${stampComment(page)}</body></html>`);
  const render = of(sent, 'avb:render').at(-1);
  assert.ok(render, 'the rendering is still announced');
  assert.equal(render.token, expectedToken([page]));
  assert.deepEqual(parsePreviewRender(render).stamps, [page], 'and the editor’s boundary accepts it');
});

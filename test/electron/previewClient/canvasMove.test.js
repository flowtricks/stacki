// Goal: a reorder dropped in the Navigator shows on the canvas at once, and the rebuilt
// page reconciles it without moving anything twice: a render of the old file keeps the
// move, a render of the new file lands on the same order, and a refused write puts the
// page back exactly as it was. The moved element is the same node throughout until the
// page is rebuilt, so its listeners and running state survive the drop.
// Method: the real morph client and the canvas's move module, bundled together from
// source into a JSDOM page that stands for the canvas, with `fetch` answering what the
// "dev server" renders now. Each page carries a source stamp (data-avb-d), as a marked
// rendering does. A move is shown as the app's message would show it; renders arrive as
// `avb:patch-now` pulls; a reload (the morph's failure mode) is a failure here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const STAMP = (letter) => `avb-d:${letter.repeat(64)}:src/pages/index.astro`;
const NODES = {
  a: '<h1 class="title">Heading</h1>',
  b: '<p class="lead">Paragraph</p>',
  c: '<section class="box"><p class="inner">Inside</p></section>',
};
// The page as the server renders it: the root list `0`, its children in `order`, each
// tagged with its path (and a child path inside the section).
function page(order, stamp) {
  const children = order.map((key, index) => {
    const tagged = NODES[key].replace(/^<(\w+)/, `<$1 data-avb-p="0.${index}"`);
    return key === 'c' ? tagged.replace('class="inner"', `class="inner" data-avb-p="0.${index}.0"`) : tagged;
  });
  return `<!doctype html><html><head><title>t</title></head><body><main data-avb-p="0" data-avb-d="${stamp}">\n${children.join('\n')}\n</main></body></html>`;
}

function load() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-move-'));
  const output = path.join(directory, 'canvas.cjs');
  buildSync({
    stdin: { contents: "import './morphClient';\nexport * from '../preload/frameMove';\n", resolveDir: repoPath('electron/previewClient'), loader: 'ts' },
    outfile: output,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    define: { 'import.meta.hot': 'undefined' },
    banner: {
      js: `const AVB_PREVIEW_LIMITS = Object.freeze(${JSON.stringify({ previewMarkersMax: LIMITS.previewMarkersMax, previewMorphWorkMax: LIMITS.previewMorphWorkMax })});`,
    },
    logLevel: 'silent',
  });
  return { output, directory };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const order = (document) =>
  [...document.querySelectorAll('main > *')].map((element) => `${element.tagName.toLowerCase()}@${element.getAttribute('data-avb-p')}`);

// Moving `b` (0.1) to the end: the gap after `c`, beside `c`.
const MOVE_PARAGRAPH_LAST = { scope: '', from: [0, 1], count: 1, parent: [0], index: 3, anchor: { path: [0, 2], placement: 'after' } };

test('a drop moves the element at once, and the rebuilt page reconciles it', async () => {
  const dom = new JSDOM(page(['a', 'b', 'c'], STAMP('a')), { url: 'http://localhost:4321/#avb-design' });
  const { window } = dom;
  let served = page(['a', 'b', 'c'], STAMP('a'));
  window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => served });
  const reloads = [];
  Object.assign(global, {
    window,
    document: window.document,
    location: window.location,
    fetch: window.fetch,
    DOMParser: window.DOMParser,
    CustomEvent: window.CustomEvent,
    Node: window.Node,
    Element: window.Element,
    Document: window.Document,
  });
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'avb:preview-reload') {
      reloads.push(event.data.reason);
    }
  });
  const { output, directory } = load();
  try {
    const canvas = require(output);
    canvas.listenForCanvasMoves();
    await settle(); // The client fetches its baseline as it loads.
    const document = window.document;
    const paragraph = document.querySelector('p.lead');
    let clicks = 0;
    paragraph.addEventListener('click', () => {
      clicks += 1;
    });
    const morphs = [];
    document.addEventListener('avb:morphed', (event) => morphs.push(event.detail));

    // The drop: in the same task, the element moves and the paths follow it.
    assert.equal(canvas.showCanvasMove(MOVE_PARAGRAPH_LAST), true);
    assert.deepEqual(order(document), ['h1@0.0', 'section@0.1', 'p@0.2']);
    assert.equal(document.querySelector('.inner').getAttribute('data-avb-p'), '0.1.0', 'a child of a shifted sibling renumbers with it');
    assert.equal(document.querySelector('main').lastElementChild, paragraph, 'the same element, not a copy');
    assert.equal(morphs.length, 1, 'the outline and regions hear of it as of a patch');
    assert.equal(canvas.canvasMovesPending(), true);

    // A render of the old file (the watcher had not seen the write yet): still moved.
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'avb:patch-now' } }));
    await settle();
    assert.deepEqual(order(document), ['h1@0.0', 'section@0.1', 'p@0.2'], 'an old-file render keeps the move');
    assert.equal(document.querySelector('p.lead'), paragraph, 'and the moved element');
    assert.equal(canvas.canvasMovesPending(), true, 'still waiting for the new file');

    // The new file: the patch lands on the order the canvas already shows, once.
    served = page(['a', 'c', 'b'], STAMP('b'));
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'avb:patch-now' } }));
    await settle();
    assert.deepEqual(order(document), ['h1@0.0', 'section@0.1', 'p@0.2'], 'the rebuilt page agrees');
    assert.equal(document.querySelectorAll('p.lead').length, 1, 'nothing moved twice');
    assert.equal(document.querySelectorAll('section.box').length, 1);
    assert.equal(canvas.canvasMovesPending(), false, 'the new file settles the move');
    assert.deepEqual(reloads, [], 'no patch fell back to a reload');
    document.querySelector('p.lead').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(clicks <= 1, 'a listener is never doubled');

    // A refused write: shown, then taken back to exactly the page it was.
    const before = document.body.innerHTML;
    const heading = document.querySelector('h1');
    assert.equal(canvas.showCanvasMove({ ...MOVE_PARAGRAPH_LAST, from: [0, 0], anchor: { path: [0, 2], placement: 'after' } }), true);
    assert.deepEqual(order(document), ['section@0.0', 'p@0.1', 'h1@0.2']);
    canvas.revertCanvasMoves();
    assert.equal(document.body.innerHTML, before, 'the page is back exactly as it was');
    assert.equal(document.querySelector('h1'), heading, 'with the same elements');
    assert.equal(canvas.canvasMovesPending(), false);
    // And the next render of the unchanged file changes nothing.
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'avb:patch-now' } }));
    await settle();
    assert.equal(document.body.innerHTML.replace(/<!--avb-d:[^>]*-->/g, ''), before.replace(/<!--avb-d:[^>]*-->/g, ''));
    assert.deepEqual(reloads, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    window.close();
  }
});

test('a move the canvas cannot show safely is left to the rebuilt page', () => {
  const dom = new JSDOM(
    '<!doctype html><body><main data-avb-p="0">' +
      '<li data-avb-p="0.0">one</li><li data-avb-p="0.0">two</li><b>x</b><li data-avb-p="0.0">three</li>' +
      '<p data-avb-p="0.1">p</p></main></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  const { output, directory } = load();
  try {
    const canvas = require(output);
    const before = dom.window.document.body.innerHTML;
    const loop = { scope: '', from: [0, 0], count: 1, parent: [0], index: 2, anchor: { path: [0, 1], placement: 'after' } };
    assert.equal(canvas.showCanvasMove(loop), false, 'a node rendered as several separate runs');
    const missing = { ...loop, anchor: { path: [0, 9], placement: 'after' } };
    assert.equal(canvas.showCanvasMove(missing), false, 'a neighbour that is not on the page');
    assert.equal(dom.window.document.body.innerHTML, before, 'nothing moved');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    dom.window.close();
  }
});

test('marker comments travel with the node and renumber', () => {
  const dom = new JSDOM(
    '<!doctype html><body><main>' +
      '<!--avb-s:0--><h1>A</h1><!--avb-e:0-->' +
      '<!--avb-s:1--><p>B</p><span>B2</span><!--avb-e:1-->' +
      '<!--avb-s:2--><section>C</section><!--avb-e:2-->' +
      '</main></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  const { output, directory } = load();
  try {
    const canvas = require(output);
    const before = dom.window.document.body.innerHTML;
    const move = { scope: '', from: [1], count: 1, parent: [], index: 0, anchor: { path: [0], placement: 'before' } };
    assert.equal(canvas.showCanvasMove(move), true);
    assert.equal(
      dom.window.document.querySelector('main').innerHTML,
      '<!--avb-s:0--><p>B</p><span>B2</span><!--avb-e:0--><!--avb-s:1--><h1>A</h1><!--avb-e:1--><!--avb-s:2--><section>C</section><!--avb-e:2-->',
    );
    canvas.revertCanvasMoves();
    assert.equal(dom.window.document.body.innerHTML, before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    dom.window.close();
  }
});

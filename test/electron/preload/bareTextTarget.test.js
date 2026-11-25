// Goal: bare words (no element of their own) are never a canvas target. Whatever the pointer does over the text
// around a <br> or a <strong> (hover, click, right click, drag, an app's point query) it is the element holding the
// words; only a double click still names the run, so text editing starts as before. A tagged inline element stays a
// target of its own, and the Navigator can still measure and outline the run.
// Method: the frame's own hit test (nodeAtPoint, electron/preload/frameTargets.ts, which click, right click and drag
// share) over JSDOM markup as the serializer writes it. JSDOM has no layout, so the point's element, the caret
// and the words' boxes are stubbed to put the pointer on a chosen run, as inlineText.test.js does. Pinned by
// source: the double click alone reads the run, and Studio's frame never resolves to one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/bare-text-target');
fs.mkdirSync(directory, { recursive: true });
const output = `${directory}/frame.cjs`;
buildSync({
  stdin: {
    contents: [
      "export { nodeAtPoint } from './electron/preload/frameTargets';",
      "export { collectRegions } from './electron/preload/frameRegions';",
      "export { rectsForPath } from './electron/preload/frameMeasure';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});

// Runs `check` over a page; `point(element, text)` puts the pointer on an element, and on its words when given.
function onPage(body, check) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`);
  const names = ['window', 'document', 'Node', 'location', 'Element', 'HTMLElement'];
  const previous = names.map((name) => global[name]);
  Object.assign(global, Object.fromEntries(names.map((name) => [name, name === 'window' ? dom.window : dom.window[name]])));
  dom.window.Range.prototype.getClientRects = () => [{ left: 0, right: 100, top: 0, bottom: 20 }];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 });
  const point = (element, text) => {
    dom.window.document.elementFromPoint = () => element;
    dom.window.document.caretRangeFromPoint = text === undefined ? () => undefined : () => ({ startContainer: text });
  };
  try {
    delete require.cache[output];
    const frame = require(output);
    frame.collectRegions();
    check({ frame, document: dom.window.document, point, at: () => frame.nodeAtPoint(10, 10)?.path });
  } finally {
    names.forEach((name, index) => (global[name] = previous[index]));
  }
}

const PARAGRAPH = '<p data-avb-p="0.1">First line of words<br data-avb-p="0.1.1">Second line of words</p>';

test('the words either side of a <br> are the paragraph’s', () => {
  onPage(PARAGRAPH, ({ document, point, at, frame }) => {
    const paragraph = document.querySelector('p');
    for (const words of [paragraph.firstChild, paragraph.lastChild]) {
      point(paragraph, words);
      assert.equal(at(), '0.1', words.data);
    }
    // The Navigator still selects the run itself, and the frame still measures it for the blue outline.
    assert.equal(frame.rectsForPath('0.1.2')?.length, 1, 'the run is still measured');
  });
});

test('words beside a tagged inline element are the parent’s; the element itself stays a target', () => {
  onPage('<h2 data-avb-p="0.2">The way we <strong data-avb-p="0.2.1">change</strong> the <a data-avb-p="0.2.3">world</a></h2>', ({ document, point, at }) => {
    const heading = document.querySelector('h2');
    point(heading, heading.firstChild);
    assert.equal(at(), '0.2');
    for (const [selector, path] of [
      ['strong', '0.2.1'],
      ['a', '0.2.3'],
    ]) {
      const inline = document.querySelector(selector);
      point(inline, inline.firstChild);
      assert.equal(at(), path, selector);
    }
  });
});

test('words that are their element’s only content, an expression’s among them, are the element', () => {
  onPage('<h3 data-avb-p="0.3">A printed title</h3>', ({ document, point, at }) => {
    const heading = document.querySelector('h3');
    point(heading, heading.firstChild);
    assert.equal(at(), '0.3');
  });
});

test('inside an element a component drew around its slot, the words are still the node’s', () => {
  onPage('<div data-avb-p="0.4"><span class="inner">Hello <em data-avb-p="0.4.1">there</em> friend</span></div>', ({ document, point, at }) => {
    const span = document.querySelector('span');
    point(span, span.lastChild);
    assert.equal(at(), '0.4');
  });
});

test('only the double click reads the bare run, and Studio’s frame never resolves to one', () => {
  const desktop = fs.readFileSync(repoPath('electron/preload/frameTargets.ts'), 'utf8');
  assert.equal(desktop.split('.textPath ??').length - 1, 1, 'one reader of the run');
  assert.match(desktop, /const nodePath = picked\.textPath \?\? picked\.path;\n\s+postLocated\('avb:open-node'/);
  assert.doesNotMatch(fs.readFileSync(repoPath('studio/src/features/preview/previewClient.ts'), 'utf8'), /inlineTextPathAt/);
});

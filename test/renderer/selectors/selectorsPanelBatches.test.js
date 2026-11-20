// Goal: the Style selectors panel draws its list 100 rows at a time and adds the next 100 only when the end
// of the list comes within 1.5 visible heights, until every row is shown; headings keep their order and a
// heading appears with its first batch; search looks through every selector, not only the drawn ones, and
// its results batch the same way; a new search or tab starts again from one batch; and a project with
// 5,000 selectors draws exactly as many rows as one with a few hundred.
// Method: render the real panel in JSDOM over a fake bridge that answers with generated reports (a real
// empty project directory answers the keep list). IntersectionObserver is replaced by a recorder, because
// JSDOM has no layout: the test reads the options the panel asks for (the scroll box as the root, 150%
// below it) and reports the end marker as reached or not, exactly when it says. Nothing is drawn before
// the marker is reported, and each report adds one batch, never more.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProjectMetadata } = require('#dist/electron/project/projectMetadata.js');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const { LIST_PAGE_ROWS, LIST_LOOKAHEAD_VIEWPORTS, nextRowLimit, firstRows } = loadRenderer('src/features/selectors/selectorList.ts');

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const DIGEST = crypto.createHash('sha256').update('x').digest('hex');
const FILES = ['src/styles/base.css', 'src/styles/patterns.css', 'src/styles/utilities.css'];

// `count` selectors, spread over the three files in order, every one in use so the panel opens on All.
function generatedReport(count) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const file = FILES[Math.min(FILES.length - 1, Math.floor((index * FILES.length) / count))];
    entries.push({
      id: `${file}|0|${index}|0`,
      rel: file,
      line: index + 1,
      selector: `.row-${String(index).padStart(5, '0')}`,
      scope: 'global',
      verdict: { kind: 'used' },
    });
  }
  return { entries, notes: [], files: FILES.map((rel) => ({ rel, digest: DIGEST })) };
}

test('rows load a batch of 100 at a time, and the pure steps are exact', () => {
  assert.equal(LIST_PAGE_ROWS, 100);
  assert.equal(LIST_LOOKAHEAD_VIEWPORTS, 1.5);
  assert.equal(nextRowLimit(100), 200);
  assert.equal(nextRowLimit(900), 1000);
  assert.throws(() => nextRowLimit(0), /a list starts with one batch/);
  assert.throws(() => nextRowLimit(150), /whole batch/);
  assert.throws(() => nextRowLimit(100.5), /whole number/);
  const groups = [
    { rel: 'a.css', entries: Array.from({ length: 60 }, (_, index) => ({ id: `a${index}` })) },
    { rel: 'b.css', entries: Array.from({ length: 60 }, (_, index) => ({ id: `b${index}` })) },
    { rel: 'c.css', entries: Array.from({ length: 60 }, (_, index) => ({ id: `c${index}` })) },
  ];
  const first = firstRows(groups, 100);
  assert.deepEqual(
    first.groups.map((group) => [group.rel, group.entries.length]),
    [
      ['a.css', 60],
      ['b.css', 40],
    ],
    'groups keep their order; a heading comes with its first rows; the last is cut short',
  );
  assert.equal(first.total, 180);
  assert.deepEqual(
    firstRows(groups, 200).groups.map((group) => group.entries.length),
    [60, 60, 60],
    'the last batch is the remainder',
  );
  assert.equal(firstRows([], 100).groups.length, 0);
});

async function harness(counts) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const observers = [];
  global.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.target = undefined;
      this.live = true;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.live = false;
    }
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-batches-'));
  let report = generatedReport(counts);
  dom.window.avb = {
    selectorUsage: async () => ({ ok: true, value: report }),
    projectMetadata: async (input) => readProjectMetadata(root, input.kind),
    writeProjectMetadata: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    onCssChanged: () => () => {},
    onFsChanged: () => () => {},
  };
  const bundle = repoPath('node_modules/.stacki-test/selectors-panel-batches.bundle.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await require('esbuild').build({
    entryPoints: [repoPath('src/features/selectors/SelectorsPanel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const SelectorsPanel = require(bundle).default;
  const container = document.getElementById('root');
  const reactRoot = createRoot(container);
  const rows = () => container.querySelectorAll('.selectors-row').length;
  const headings = () => [...container.querySelectorAll('.selectors-file')].map((heading) => heading.textContent);
  const live = () => observers.filter((observer) => observer.live && observer.target !== undefined && observer.target.isConnected);
  const open = async () => {
    const started = performance.now();
    await act(async () => {
      reactRoot.render(React.createElement(SelectorsPanel, { project: { path: root }, showToast: () => {}, onRecordUndo: () => {} }));
      await settle(30);
    });
    for (let attempt = 0; attempt < 200 && rows() === 0; attempt += 1) {
      await act(async () => settle(25));
    }
    return performance.now() - started;
  };
  // The end marker comes within reach: the panel adds one batch.
  const reach = async () => {
    const [observer] = live();
    assert.ok(observer, 'an end marker is being watched');
    await act(async () => observer.callback([{ isIntersecting: true }]));
  };
  const search = async (text) => {
    const input = container.querySelector('.selectors-search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await settle(20);
    });
  };
  const finish = async () => {
    await act(async () => reactRoot.unmount());
    delete global.IntersectionObserver;
    dom.window.close();
  };
  return { open, reach, search, rows, headings, live, container, finish, setReport: (next) => (report = next) };
}

test('the next 100 rows load when the end comes within reach, and not before, until all are shown', async () => {
  const panel = await harness(495);
  try {
    await panel.open();
    assert.equal(panel.rows(), 100, 'the first frame draws one batch');
    assert.deepEqual(panel.headings(), ['base.css'], 'the first file is longer than a batch, so the later headings wait for their first rows');
    const [observer] = panel.live();
    assert.equal(observer.options.rootMargin, '0px 0px 150% 0px', 'the end is watched 1.5 visible heights ahead');
    assert.ok(observer.options.root.classList.contains('selectors-body'), 'measured against the scroll box, which clips the list');
    // Nothing happens until the marker is reported: no timer and no scroll loads rows by itself.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(panel.rows(), 100, 'not before the end is near');
    await panel.reach();
    assert.deepEqual(panel.headings(), ['base.css', 'patterns.css'], 'a heading appears with its first rows, in order');
    const seen = [200];
    for (let batch = 0; batch < 3; batch += 1) {
      await panel.reach();
      seen.push(panel.rows());
    }
    assert.deepEqual(seen, [200, 300, 400, 495], 'a batch at a time, the last one the remainder');
    assert.equal(panel.live().length, 0, 'nothing is watched once every row is shown');
    assert.deepEqual(panel.headings(), ['base.css', 'patterns.css', 'utilities.css'], 'every heading, in order');
    // Rows already drawn stay mounted and in place.
    assert.equal(panel.container.querySelectorAll('.selectors-row')[0].textContent.includes('.row-00000'), true);
    assert.equal(panel.container.querySelectorAll('.selectors-row')[494].textContent.includes('.row-00494'), true);
  } finally {
    await panel.finish();
  }
});

test('search looks through every selector, batches its results, and a new search starts from one batch', async () => {
  const panel = await harness(495);
  try {
    await panel.open();
    await panel.search('row-0049');
    assert.equal(panel.rows(), 5, 'the matches past the first batch (.row-00490 to .row-00494) are found without scrolling');
    assert.ok(panel.container.textContent.includes('.row-00490'), 'a selector that was never drawn is searched');
    await panel.search('row-00');
    assert.equal(panel.rows(), 100, 'many results start at one batch');
    await panel.reach();
    assert.equal(panel.rows(), 200);
    await panel.search('row-0');
    assert.equal(panel.rows(), 100, 'a new search resets the loaded count');
    await panel.search('');
    assert.equal(panel.rows(), 100, 'clearing it does too');
  } finally {
    await panel.finish();
  }
});

test('5,000 selectors draw as many rows and as much of the page as 495', async () => {
  const small = await harness(495);
  let smallMs;
  let smallNodes;
  try {
    smallMs = await small.open();
    smallNodes = small.container.getElementsByTagName('*').length;
  } finally {
    await small.finish();
  }
  const big = await harness(5000);
  try {
    const bigMs = await big.open();
    const bigNodes = big.container.getElementsByTagName('*').length;
    assert.equal(big.rows(), 100);
    // The big list's extra rows are not drawn, so the page is the same size; the total only appears in the tab's number.
    assert.ok(Math.abs(bigNodes - smallNodes) <= 4, `nodes: ${bigNodes} against ${smallNodes}`);
    for (let batch = 0; batch < 3; batch += 1) {
      await big.reach();
    }
    assert.equal(big.rows(), 400);
    // A generous time bound, since only a list that draws everything could miss it: 5,000 rows draw in well over 10x.
    assert.ok(bigMs < Math.max(smallMs * 10, 1500), `open: ${Math.round(bigMs)} ms against ${Math.round(smallMs)} ms`);
  } finally {
    await big.finish();
  }
});

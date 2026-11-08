// The query dropdown's selectors line: what a row lists under its query, and how
// that list fits the row.
//
//   node test/renderer/style/querySelectorLine.test.js
//
// Goal, in three parts.
//
// 1. A row lists the selectors written INSIDE its query, read from the parsed
//    stylesheet: each list member on its own, each once, in source order, nested
//    rules resolved up to the query. A selector AROUND the query stays the row's
//    wrapper line and is never repeated here, and a query with nothing inside it
//    gives no line at all.
// 2. The line holds as many whole selectors as the real row width allows, then an
//    ellipsis. A name is only ever cut when it alone is wider than the row, and
//    the title carries the whole list.
// 3. The third line does not disturb the row: the dot and check keep their slots,
//    the closed trigger keeps its height, and a capped list cannot squeeze the row.
//
// Method: rules parsed by the real postcss path (parseRegion) and read back through
// the model; fitSubline driven by a fixed-width measure; the shared Select mounted in
// jsdom, which has no layout, with the row's width and the canvas stubbed so the
// component's own measuring path runs, and the observer fired to stand for a resize.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const settle = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const { LIMITS } = load('shared/core/limits.ts');
const { parseRegion } = load('src/features/style/model/css.ts');
const { QUERY_SELECTOR_LIMITS, indexPlacedContexts, indexQuerySelectors, selectorsInContext, sourcedContextKey } = load(
  'src/features/style/model/queryWrapper.ts',
);

const regionOf = (css) => parseRegion({ start: 0, end: css.length, css, root: undefined, openTag: '<style>' });
const documentOf = (key, order, ...sheets) => ({ source: { key, order }, regions: sheets.map(regionOf) });
const QUERY = '@media (width < 50rem)';
const rowOf = (placed, source = 'sheet') => ({ key: sourcedContextKey(placed, source), embedAtContext: QUERY });
const selectorsOf = (css, placed = QUERY) => [...selectorsInContext(indexQuerySelectors([documentOf('sheet', 0, css)]), rowOf(placed))];

// ── 1. What a row lists ─────────────────────────────────────────────────────
{
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { :root { --h1: 5rem; } }`), [':root'], 'a selector inside the query');
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { :root { --h1: 5rem } .card { gap: 0 } .hero_title { margin: 0 } }`),
    [':root', '.card', '.hero_title'],
    'several selectors, in source order',
  );
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { h1, h2 { margin: 0 } }`), ['h1', 'h2'], 'a list counts as separate entries');
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { :is(h1, h2) a, h3 { margin: 0 } }`),
    [':is(h1, h2) a', 'h3'],
    'a comma inside a function does not split',
  );
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { .b { top: 0 } .a, .b { left: 0 } .a { right: 0 } }`),
    ['.b', '.a'],
    'a duplicate appears once, where it first appears',
  );
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { .a { top: 0 } } .between { top: 0 } @media (width < 50rem) { .a { left: 0 } .b { left: 0 } }`),
    ['.a', '.b'],
    'one query written twice in a stylesheet is one row',
  );
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { .a { top: 0; &:hover { top: 1px } .b { top: 2px } } }`),
    ['.a', '.a:hover', '.a .b'],
    'nested rules resolve up to the query',
  );
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { .a { .b { top: 0 } } }`), ['.a .b'], 'a rule holding only other rules is a path, not an entry');
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { .a, .b { .c { top: 0 } } }`), ['.a .c', '.b .c'], 'a nested list expands');
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { @layer base { .a { top: 0 } } }`), ['.a'], 'a layer is walked through');
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { .a {} }`), ['.a'], 'an empty rule still names a selector');
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) {\n  .a,\n  .b   .c { top: 0 }\n}`),
    ['.a', '.b .c'],
    'whitespace in the source does not make a new entry',
  );

  // The negative space: what sits near a query and is not in it.
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { }`), [], 'an empty query has none');
  assert.deepEqual(selectorsOf(`@media (width < 50rem) { @keyframes pulse { from { top: 0 } to { top: 1px } } }`), [], 'keyframe stops are not selectors');
  assert.deepEqual(selectorsOf(`.outside { top: 0 } @media (width < 50rem) { }`), [], 'a rule beside the query is not in it');
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { .a { top: 0 } @media (hover: hover) { .inner { top: 0 } } }`),
    ['.a'],
    'an inner query is a row of its own, so the outer one does not claim it',
  );
  assert.deepEqual(
    selectorsOf(`@media (width < 50rem) { @media (hover: hover) { .inner { top: 0 } } }`, `${QUERY} › @media (hover: hover)`),
    ['.inner'],
    'the inner query lists its own',
  );
}

// A selector outside the query stays the wrapper; both kinds each keep their place.
{
  const nestedKey = `.stat_layout { ${QUERY} }`;
  assert.deepEqual(selectorsOf(`.stat_layout { @media (width < 50rem) { gap: 0 } }`, nestedKey), [], 'the wrapper is not listed under its own query');
  assert.deepEqual(selectorsOf(`.stat_layout { @media (width < 50rem) { & { gap: 0 } } }`, nestedKey), [], 'a bare & is the wrapper again');
  assert.deepEqual(
    selectorsOf(`.stat_layout { @media (width < 50rem) { gap: 0; .child { gap: 0 } } }`, nestedKey),
    ['.child'],
    'both kinds: only what is inside, as written',
  );

  const css = `.stat_layout { @media (width < 50rem) { gap: 0; .child { gap: 0 } } } @media (width < 50rem) { .top { gap: 0 } }`;
  const index = indexQuerySelectors([documentOf('sheet', 0, css)]);
  const contexts = [
    { ...rowOf(nestedKey), label: QUERY, breakpoint: undefined },
    { ...rowOf(QUERY), label: QUERY, breakpoint: undefined },
    { key: sourcedContextKey(`.empty { ${QUERY} }`, 'sheet'), label: QUERY, breakpoint: undefined, embedAtContext: QUERY },
    { key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' },
  ];
  const infos = indexPlacedContexts({ base: [], conditional: [], matchedRuleCount: 0 }, contexts, index);
  assert.deepEqual(
    infos.map((info) => [info.wrapper, info.querySelectors]),
    [
      ['.stat_layout', ['.child']],
      [undefined, ['.top']],
      ['.empty', undefined],
      [undefined, undefined],
    ],
    'each row carries its own wrapper and selectors, and a row with none carries no list',
  );
  assert.equal('querySelectors' in infos[3], false, 'Base has no list, not an empty one');
}

// Rows are places: two stylesheets are two rows, and a breakpoint row stands for all.
{
  const index = indexQuerySelectors([
    documentOf('late', 2, `@media (width < 50rem) { .late { top: 0 } }`),
    documentOf('early', 1, `@media (width < 50rem) { .early { top: 0 } }`, `@media (width < 50rem) { .second-block { top: 0 } }`),
  ]);
  assert.deepEqual(selectorsInContext(index, rowOf(QUERY, 'late')), ['.late'], 'one stylesheet does not borrow from another');
  assert.deepEqual(selectorsInContext(index, rowOf(QUERY, 'early')), ['.early', '.second-block'], 'two <style> blocks of one file are one stylesheet');
  assert.deepEqual(
    selectorsInContext(index, { key: 'bp:medium', embedAtContext: QUERY }),
    ['.early', '.second-block', '.late'],
    'a breakpoint row reads every stylesheet, in cascade order',
  );
  assert.deepEqual(selectorsInContext(index, { key: '', embedAtContext: '' }), [], 'Base is no query');
}

// Bounds: a list a stylesheet multiplies stays capped, and a broken sheet gives none.
{
  const max = QUERY_SELECTOR_LIMITS.entriesMax;
  const many = Array.from({ length: max + 50 }, (_, index) => `.s${index}`);
  const listed = selectorsOf(`@media (width < 50rem) { ${many.map((selector) => `${selector} { top: 0 }`).join(' ')} }`);
  assert.equal(listed.length, max, 'entries stop at the limit');
  assert.deepEqual(listed.slice(0, 2), ['.s0', '.s1'], 'and the first ones are the ones kept');

  const twenty = Array.from({ length: 20 }, (_, index) => `.n${index}`).join(', ');
  const multiplied = `@media (width < 50rem) { .kept { top: 0 } ${twenty} { ${twenty} { top: 0 } } }`;
  assert.deepEqual(selectorsOf(multiplied), ['.kept'], 'a chain that would expand past the limit is left out, not expanded');

  // Past the tree depth limit nothing more is walked, by rules or by layers alone.
  const depthPast = LIMITS.treeDepthMax + 5;
  const deepRules = `@media (width < 50rem) { .top { top: 0 } ${'.n { '.repeat(depthPast)}top: 0${' }'.repeat(depthPast)} }`;
  assert.equal(selectorsOf(deepRules)[0], '.top', 'rules nested past the limit neither crash nor lose what came first');
  const deepLayers = `@media (width < 50rem) { .top { top: 0 } ${'@layer a { '.repeat(depthPast)}.deep { top: 0 }${' }'.repeat(depthPast)} }`;
  assert.deepEqual(selectorsOf(deepLayers), ['.top'], 'layers nested past the limit are not walked');

  const unparsed = { source: { key: 'sheet', order: 0 }, regions: [{ start: 0, end: 0, css: '', root: undefined }] };
  assert.equal(indexQuerySelectors([unparsed]).size, 0, 'a region that did not parse lists nothing');
}

// ── 2 and 3. The row ────────────────────────────────────────────────────────
(async () => {
  const esbuild = require('esbuild');
  // Inside node_modules so the bundle's external React resolves to the repository's.
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, 'query-selector-line.bundle.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        `export { default } from './src/features/style/components/Select.tsx';`,
        `export { fitSubline } from './src/features/style/components/SelectViews.tsx';`,
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const observers = [];
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
    }
    observe() {
      this.connected = true;
      observers.push(this);
    }
    unobserve() {}
    disconnect() {
      this.connected = false;
    }
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const selectModule = require(bundle);
  const Select = selectModule.default;
  const { fitSubline } = selectModule;

  // Ten pixels a character keeps every expected width readable from the string.
  const PX_PER_CHARACTER = 10;
  const measure = (text) => text.length * PX_PER_CHARACTER;
  const items = [':root', '.card', '.hero_title'];

  // `:root, .card, .hero_title` is 25 characters; `:root, .card, …` is 15; `:root, …` is 8.
  assert.equal(fitSubline(items, 250, measure), ':root, .card, .hero_title', 'exactly the full width: everything, no ellipsis');
  assert.equal(fitSubline(items, 249, measure), ':root, .card, …', 'one pixel less: the last selector goes whole, not in part');
  assert.equal(fitSubline(items, 150, measure), ':root, .card, …', 'the ellipsis is counted in the width');
  assert.equal(fitSubline(items, 149, measure), ':root, …', 'one pixel less: one fewer selector');
  assert.equal(fitSubline(items, 10, measure), ':root, …', 'the first selector always shows, for the line to cut in plain sight');
  assert.equal(fitSubline(['.only'], 10, measure), '.only', 'a single selector has nothing after it to mark');
  assert.equal(fitSubline(['.a', '.b'], 10, measure), '.a, …', 'two selectors, room for one');
  assert.throws(() => fitSubline([], 100, measure), /Assertion failed: fitSubline: a subline has items/, 'an empty list never reaches the fit');
  assert.throws(() => fitSubline(items, -1, measure), /Assertion failed: fitSubline: a width is not negative/, 'a width is measured, so never negative');
  {
    const calls = [];
    const hundred = Array.from({ length: 100 }, (_, index) => `.s${index}`);
    fitSubline(hundred, 100, (text) => {
      calls.push(text);
      return measure(text);
    });
    assert.ok(calls.length < 10, 'measuring stops at the first miss, not at the end of the list');
  }

  // The stubbed layout: every line is `widthPx` wide, and text measures as above.
  let widthPx = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => widthPx });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ font: '', letterSpacing: '', measureText: (text) => ({ width: measure(text) }) });

  const mount = async (value, options) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Select, { value, options, onChange: () => {} }));
      await settle();
    });
    await act(async () => {
      host.querySelector('.u-select-button').click();
      await settle();
    });
    return { host, root };
  };
  const lines = (row) => [...row.querySelector('.u-select-label').children].map((child) => [child.className, child.textContent]);
  const tag = { label: '<style>', tone: 'embed' };
  const selected = '@media (width < 50rem)';
  const options = [
    { value: '', label: 'Base', marked: true },
    { value: selected, label: selected, tag, subline: items, marked: true },
    { value: 'both', label: '@media (width < 75rem)', overline: '.stat_layout', tag, subline: ['.child'] },
    { value: 'wrapped', label: '@media (width < 75rem)', overline: '.stat_layout', tag },
    { value: 'bp', label: 'Tablet', subline: ['.only'] },
    { value: 'none', label: '@media (width < 30rem)', tag, subline: [] },
  ];

  widthPx = 151; // 150 once the rounding slack is held back.
  const { host, root } = await mount(selected, options);
  const rows = [...host.querySelectorAll('.u-select-option')];
  const [base, inner, both, wrapped, breakpoint, none] = rows;
  assert.deepEqual(
    lines(inner),
    [
      ['u-select-overline', '<style>'],
      ['u-select-label-line', selected],
      ['u-select-subline', ':root, .card, …'],
    ],
    'chip line, query line, selectors line, fitted to the row',
  );
  assert.equal(inner.querySelector('.u-select-subline').title, ':root, .card, .hero_title', 'the title keeps the whole list');
  assert.deepEqual(
    lines(both),
    [
      ['u-select-overline', '<style>.stat_layout'],
      ['u-select-label-line', '@media (width < 75rem)'],
      ['u-select-subline', '.child'],
    ],
    'both kinds: the wrapper above the query, the inside below it',
  );
  assert.deepEqual(
    lines(wrapped),
    [
      ['u-select-overline', '<style>.stat_layout'],
      ['u-select-label-line', '@media (width < 75rem)'],
    ],
    'a selector outside the query is exactly the row it was',
  );
  assert.deepEqual(
    lines(breakpoint),
    [
      ['u-select-label-line', 'Tablet'],
      ['u-select-subline', '.only'],
    ],
    'a row with no first line draws no empty one',
  );
  assert.equal(none.querySelector('.u-select-subline') ?? undefined, undefined, 'no selectors, no empty line');
  assert.equal(none.classList.contains('has-subline'), false, 'and the row stays its usual height');
  assert.equal(base.querySelector('.u-select-subline') ?? undefined, undefined, 'Base has no line');
  assert.ok(inner.classList.contains('has-subline'), 'a row with the line says so, for its height');

  for (const row of rows) {
    assert.deepEqual(
      [...row.children].slice(-2).map((child) => child.className),
      ['u-select-dot-slot', 'u-select-check'],
      `${row.textContent}: the dot slot, then the check, still end the row`,
    );
  }
  assert.ok(inner.querySelector('.u-select-check > svg'), 'the selected row has its check at the end');
  assert.equal(host.querySelector('.u-select-button .u-select-subline') ?? undefined, undefined, 'the closed trigger keeps its height: no selectors line');

  // The row narrows and widens: the count follows it, not a fixed number.
  const subline = () => inner.querySelector('.u-select-subline').textContent;
  const resize = async (next) => {
    widthPx = next;
    await act(async () => {
      for (const observer of observers) {
        if (observer.connected) {
          observer.callback([]);
        }
      }
      await settle();
    });
  };
  await resize(100);
  assert.equal(subline(), ':root, …', 'a narrower row shows fewer');
  await resize(400);
  assert.equal(subline(), ':root, .card, .hero_title', 'a wider row shows them all');
  await resize(0);
  assert.equal(subline(), ':root, .card, .hero_title', 'a line with no layout holds the whole list for CSS to end');

  await act(async () => {
    root.unmount();
    await settle();
  });
  assert.equal(
    observers.some((observer) => observer.connected),
    false,
    'closing the list stops watching its rows',
  );

  // The stylesheet: the line matches the muted overline, the row may not be squeezed
  // by the list's height cap, and the app's no-borders rule holds.
  const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
  const muted = /\.u-select-overline,\n\.u-select-subline \{([^}]*)\}/.exec(css);
  assert.ok(muted, 'the overline and the selectors line share one text style');
  assert.match(muted[1], /color: var\(--color-text-secondary\);/, 'muted');
  assert.match(muted[1], /font-size: var\(--font-size-xs\);/, 'and small');
  assert.match(css, /\.u-select-label-line,\n\.u-select-subline \{[^}]*white-space: nowrap;/, 'the line never wraps');
  const row = /\.u-select-option\.has-subline \{([^}]*)\}/.exec(css);
  assert.ok(row, 'a three-line row has its own rule');
  assert.match(row[1], /flex-shrink: 0;/, 'a capped list scrolls rather than squeezes the row');
  assert.doesNotMatch(row[1], /border/, 'no borders');

  dom.window.close();
  console.log('query-selector-line: passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

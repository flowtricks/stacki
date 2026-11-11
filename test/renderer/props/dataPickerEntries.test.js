// Goal: the binding picker lets a list of entries be browsed one entry at a time — a project
// collection's `stats` opens on ‹ 1/4 › with the chosen entry's fields, not only entry `0` —
// while what a click binds stays exactly the path the row shows (`stats[2].data.Header`). And
// every group of rows is headed by where its data lives, naming the file the binding is
// written into, so a component's own props and frontmatter never read as the page's.
// Method: the pure model (dataPickerModel.ts) is driven directly: pages from a bound path,
// stepping with wrap-around at both ends, clamping a remembered place, the single-entry and
// empty cases that get no pager, and the rows a page shows; invalid input pins its assertion.
// The data tree is built for a project collection with samples keyed as the app files them
// (the representative entry, then entries read by position), and its entry nodes, paths and
// counts are read. Finally the real DataPicker is rendered to static markup — pager, shown
// entry, the reading row for an entry not read yet, and the source headings for a component.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');
const { entryPageOf, entryPath, pagesOfPath, sectionHeading, shownEntryRows, steppedEntryIndex } = loadRenderer('src/features/props/dataPickerModel.ts');
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');
const { entrySampleKey } = loadRenderer('src/editor/dataSample.ts');

const STATS = [
  { id: 'uptime', collection: 'stats', data: { Number: '61.4%', Header: 'Uptime', Description: 'weather permitting' } },
  { id: 'sites', collection: 'stats', data: { Number: '12', Header: 'Sites', Description: 'and counting' } },
  { id: 'teams', collection: 'stats', data: { Number: '40', Header: 'Teams', Description: 'worldwide' } },
  { id: 'years', collection: 'stats', data: { Number: '9', Header: 'Years', Description: 'in business' } },
];

const list = (count, children) => ({ path: 'stats', entryCount: count, children });
const entries = (indexes) => indexes.map((index) => ({ path: `stats[${index}]` }));

test('a list of entries pages through every entry, wrapping at both ends', () => {
  const page = entryPageOf(list(4, entries([0])), {});
  assert.deepEqual(page, { index: 0, count: 4 });
  assert.equal(steppedEntryIndex(page, 1), 1);
  assert.equal(steppedEntryIndex(page, -1), 3, 'back from the first entry is the last');
  assert.equal(steppedEntryIndex({ index: 3, count: 4 }, 1), 0, 'on from the last entry is the first');
  assert.deepEqual(entryPageOf(list(4, entries([0])), { stats: 2 }), { index: 2, count: 4 });
  assert.deepEqual(entryPageOf(list(4, entries([0])), { stats: 9 }), { index: 3, count: 4 }, 'a place past the end reads as the last entry');
  assert.deepEqual(entryPageOf(list(4, entries([0])), { stats: -3 }), { index: 0, count: 4 });
});

test('one entry, no entries, or no children get no pager', () => {
  assert.equal(entryPageOf(list(1, entries([0])), {}), undefined);
  assert.equal(entryPageOf(list(0, undefined), {}), undefined);
  assert.equal(entryPageOf(list(undefined, entries([0, 1])), {}), undefined);
  assert.equal(entryPageOf(list(4, undefined), {}), undefined, 'a list shown without its entries has nothing to page');
  assert.throws(() => steppedEntryIndex({ index: 0, count: 1 }, 1), /a single entry has nowhere to step/);
  assert.throws(() => steppedEntryIndex({ index: 4, count: 4 }, 1), /the index is inside the list/);
  assert.throws(() => entryPageOf(list(2.5, entries([0])), {}), /entry count is an integer/);
  assert.throws(() => entryPath('stats', -1), /index is not negative/);
});

test('a page shows the chosen entry, the current binding’s missing row, and says when it is unread', () => {
  const missing = { path: 'stats[2].data.Header', missing: true };
  const children = [...entries([0, 1]), missing];
  assert.deepEqual(shownEntryRows('stats', children, { index: 1, count: 4 }), { rows: [children[1], missing], unread: false });
  assert.deepEqual(shownEntryRows('stats', children, { index: 2, count: 4 }), { rows: [missing], unread: true });
});

test('a bound path opens each list on the entry it names', () => {
  assert.deepEqual(pagesOfPath('stats[2].data.Header'), { stats: 2 });
  assert.deepEqual(pagesOfPath('post.data.tags[1].items[3]'), { 'post.data.tags': 1, 'post.data.tags[1].items': 3 });
  assert.deepEqual(pagesOfPath('post.data["campus-name"]'), {});
  assert.deepEqual(pagesOfPath(undefined), {});
  assert.throws(() => pagesOfPath('x'.repeat(8193)), /binding path limit exceeded/);
});

test('a project collection offers every entry it has read, each at its own position', () => {
  // The query a pick writes is named `statsEntries`, so every row's path starts there.
  const collections = [{ name: 'stats', count: 4 }];
  const context = (samples) => ({ frontmatter: '', collections, collectionSamples: samples });
  // Only the representative entry: it stands for `[0]`, and the pager still counts all four.
  const first = dataTree(context({ stats: STATS[0] })).find((node) => node.key === 'stats');
  assert.equal(first.section, 'collections');
  assert.equal(first.entryCount, 4);
  assert.equal(first.preview, '4 entries');
  assert.deepEqual(
    first.children.map((child) => child.path),
    ['statsEntries[0]'],
  );
  // Entries read by position sit at their positions, and a click on a field binds through it.
  const read = dataTree(context({ stats: STATS[0], [entrySampleKey('stats', 2)]: STATS[2], [entrySampleKey('stats', 7)]: STATS[3] })).find(
    (node) => node.key === 'stats',
  );
  assert.deepEqual(
    read.children.map((child) => child.path),
    ['statsEntries[0]', 'statsEntries[2]'],
    'an entry past the count is not offered',
  );
  const header = read.children[1].children.find((child) => child.key === 'data').children.find((child) => child.key === 'Header');
  assert.equal(header.path, 'statsEntries[2].data.Header');
  assert.equal(header.preview, '"Teams"');
  // A collection of one, or of unknown size, has nothing to page.
  const single = dataTree({ frontmatter: '', collections: [{ name: 'stats', count: 1 }], collectionSamples: { stats: STATS[0] } })[0];
  assert.equal(single.entryCount, undefined);
  const unknown = dataTree({ frontmatter: '', collections: [{ name: 'stats' }], collectionSamples: { stats: STATS[0] } })[0];
  assert.equal(unknown.entryCount, undefined);
  const empty = dataTree({ frontmatter: '', collections: [{ name: 'stats', count: 0 }], collectionSamples: {} })[0];
  assert.equal(empty.entryCount, undefined);
  assert.equal(empty.children, undefined);
});

test('a sampled list of records pages; a list of words does not', () => {
  const frontmatter = ["const statsEntries = await getCollection('stats');", "const tags = ['a', 'b'];"].join('\n');
  const tree = dataTree({ frontmatter, valueSamples: { statsEntries: STATS, tags: ['a', 'b'] } });
  const stats = tree.find((node) => node.path === 'statsEntries');
  assert.equal(stats.entryCount, 4);
  assert.equal(stats.section, 'frontmatter');
  assert.equal(tree.find((node) => node.path === 'tags').entryCount, undefined);
});

test('every group is headed by where its data lives', () => {
  const component = { file: 'src/components/Button.astro', page: 'src/pages/index.astro' };
  // A heading is only the group's name: no note says what its data depends on.
  assert.equal(sectionHeading('props', component), 'Button', 'a component’s props are headed by its name');
  assert.equal(sectionHeading('frontmatter', component), 'Button.astro frontmatter');
  assert.equal(sectionHeading('collections', component), 'Content Collections');
  const page = { file: 'src/pages/index.astro', page: undefined };
  assert.equal(sectionHeading('frontmatter', page), 'index.astro frontmatter');
  assert.equal(sectionHeading('props', page), 'index.astro props');
  assert.equal(sectionHeading('loop', page), 'Loop item');
  assert.equal(sectionHeading('frontmatter', undefined), 'Frontmatter');
  assert.equal(sectionHeading('unknown', page), undefined);
  // Every root of a component's tree carries a section, so none is left unheaded.
  const tree = dataTree({ frontmatter: "const { href } = Astro.props;\nconst label = 'Go';", ancestorHeads: ['items.map((item) => ('] });
  assert.deepEqual(
    tree.map((node) => [node.path, node.section]),
    [
      ['item', 'loop'],
      ['href', 'props'],
      ['label', 'frontmatter'],
    ],
  );
});

test('the picker renders the pager, the chosen entry, and the source headings', () => {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'data-picker-entries.bundle.cjs');
  buildSync({
    stdin: { contents: "export { default as DataPicker } from './src/features/props/DataPicker.tsx';", resolveDir: ROOT },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  const { DataPicker } = require(output);
  const samples = { stats: STATS[0], [entrySampleKey('stats', 2)]: STATS[2] };
  const tree = dataTree({ frontmatter: '', collections: [{ name: 'stats', count: 4 }], collectionSamples: samples });
  const origin = { file: 'src/components/Button.astro', page: 'src/pages/index.astro' };
  const render = (current) => renderToStaticMarkup(React.createElement(DataPicker, { tree, current, origin, onPick() {}, onExpand() {} }));

  // Opened on a binding to the third entry: the pager says so and the rows are that entry's.
  const third = render('statsEntries[2].data.Header');
  assert.match(third, /dp-item-count">3\/4</);
  assert.match(third, /Teams/);
  assert.doesNotMatch(third, /Uptime/, 'only the chosen entry is shown');
  assert.match(third, /title="statsEntries\[2\]\.data\.Header/);
  assert.match(third, /Content Collections/);
  assert.doesNotMatch(third, /Works anywhere|dp-section-note/, 'a section heading carries no note');

  // Nothing bound: the content collections fold under their heading, which
  // carries Astro's mark, and nothing in them is drawn.
  const closed = render(undefined);
  assert.doesNotMatch(closed, /dp-item-count/, 'no entry is opened');
  assert.doesNotMatch(closed, /title="statsEntries/, 'the folded collection draws no rows');
  assert.match(closed, /class="dp-section collapsible"[^>]*aria-expanded="false"/, 'the heading says it is folded');
  assert.match(closed, /<svg[^>]*dp-section-icon/, 'the Content Collections heading carries the Astro mark');

  // Laid open, as the loop's Source picker draws it: the collection row closed, with the CMS mark.
  const laid = renderToStaticMarkup(React.createElement(DataPicker, { tree, current: undefined, origin, sources: 'open', onPick() {}, onExpand() {} }));
  assert.doesNotMatch(laid, /title="statsEntries\[0\]\.data/, 'no entry fields are listed');
  assert.match(laid, /title="Content collection"/, 'the collection row carries the CMS mark');

  // Bound to an entry not read yet: the reading row stands in for it.
  const unread = render('statsEntries[1].data.Header');
  assert.match(unread, /dp-item-count">2\/4</);
  assert.match(unread, /Reading one entry…/);
});

// Goal: the Components panel's instance counts follow the open file's tree in the same render as
// the tree, under the scan's own counting rules, and a scan that read a file before its last save
// never puts an old count back (src/app/model/liveInstanceCounts.ts, src/app/model/scanSequence.ts).
//
// Methodology: pure functions over real parses (the .astro parser main uses). Each live count is
// compared with the scan's own counter (electron/properties/componentUsage.ts instanceCounts) on
// the same text, so the two can never disagree on load; a table walks one page through delete,
// undo, redo, cut, paste and move and checks the panel total after every step; the held-file
// reducer is driven through leave, stale scan and fresh scan; paths are built with both
// separators to hold the Windows case; an 8,000-node tree pins the cost as linear.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { instanceCounts } = require('#dist/electron/properties/componentUsage.js');
const { HELD_FILES_MAX, fileInstanceCounts, nextHeldFiles, projectFileKey, withLiveInstances } = loadRenderer('src/app/model/liveInstanceCounts.ts');
const { scanBegin, scanRecord, scanSequenceLatest, scanSequenceOf } = loadRenderer('src/app/model/scanSequence.ts');

const PROJECT = '/project';
const PAGE = '/project/src/pages/index.astro';
const DIV = { name: 'Div', path: '/project/src/components/Div.astro', file: 'src/components/Div.astro', folder: '' };
const CARD = { name: 'Card', path: '/project/src/components/Card.astro', file: 'src/components/Card.astro', folder: '' };
const BASE = { name: 'BaseLayout', path: '/project/src/layouts/BaseLayout.astro', file: 'src/layouts/BaseLayout.astro', folder: 'layouts', isLayout: true };
const COMPONENTS = [DIV, CARD, BASE];

const FRONTMATTER =
  "---\nimport Div from '../components/Div.astro';\nimport Card from '../components/Card.astro';\nimport Layout from '../layouts/BaseLayout.astro';\n---\n";

function modelOf(source) {
  const parsed = parsePage(source, { locs: false });
  assert.equal(parsed.editable, true, 'the fixture parses as an editable page');
  return parsed.model;
}

function liveCounts(source, path = PAGE) {
  return fileInstanceCounts(modelOf(source), { project: PROJECT, path, components: COMPONENTS });
}

function scanCount(source, component, path = PAGE) {
  return instanceCounts(source, path, [])({ targetPath: component.path, name: component.name });
}

test('a file key is project-relative and /-separated with either separator', () => {
  assert.equal(projectFileKey('/project', '/project/src/pages/index.astro'), 'src/pages/index.astro');
  assert.equal(projectFileKey('/project/', '/project/src/pages/index.astro'), 'src/pages/index.astro');
  assert.equal(projectFileKey('C:\\Sites\\project', 'C:\\Sites\\project\\src\\pages\\index.astro'), 'src/pages/index.astro');
  assert.equal(projectFileKey('/project', '/elsewhere/index.astro'), undefined);
  assert.equal(projectFileKey('/project', '/projectile/index.astro'), undefined);
  assert.equal(projectFileKey('', '/project/index.astro'), undefined);
});

// Each row: a page body and the count of each component in it, which must also be the scan's count.
const SHAPES = [
  { name: 'one instance', body: '<Div />\n', div: 1, card: 0, layout: 0 },
  { name: 'none (the last instance gone)', body: '<p>Text</p>\n', div: 0, card: 0, layout: 0 },
  { name: 'in a slot', body: '<Card><Div /><Div></Div></Card>\n', div: 2, card: 1, layout: 0 },
  { name: 'nested instances', body: '<Div><Div><Div /></Div></Div>\n', div: 3, card: 0, layout: 0 },
  { name: 'in a loop: nodes, not iterations', body: '<ul>{[1, 2, 3].map((item) => <Div />)}</ul>\n', div: 1, card: 0, layout: 0 },
  { name: 'in a conditional', body: '{true && <Div />}\n{false ? <Div /> : <Card />}\n', div: 2, card: 1, layout: 0 },
  { name: 'in a layout, under its import name', body: '<Layout><Div /></Layout>\n', div: 1, card: 0, layout: 1 },
  { name: 'in a comment, as the scan reads it', body: '<!-- <Div /> -->\n<Div />\n', div: 2, card: 0, layout: 0 },
];

for (const shape of SHAPES) {
  test(`live count equals the scan's count: ${shape.name}`, () => {
    const source = FRONTMATTER + shape.body;
    const live = liveCounts(source);
    assert.equal(live.file, 'src/pages/index.astro');
    assert.equal(live.counts.get(DIV.path) ?? 0, shape.div);
    assert.equal(live.counts.get(CARD.path) ?? 0, shape.card);
    assert.equal(live.counts.get(BASE.path) ?? 0, shape.layout);
    assert.equal(scanCount(source, DIV), shape.div, 'the scan counts the same');
    assert.equal(scanCount(source, CARD), shape.card, 'the scan counts the same');
    assert.equal(scanCount(source, BASE), shape.layout, 'the scan counts the same');
  });
}

test('a component file is not one of its own users', () => {
  const live = liveCounts("---\nimport Div from './Div.astro';\n---\n<Div />\n", DIV.path);
  assert.equal(live.counts.get(DIV.path), undefined);
});

test('a Windows project resolves its imports and keys the file the same way', () => {
  const windows = COMPONENTS.map((entry) => ({ ...entry, path: 'C:\\Sites\\project\\' + entry.file.replaceAll('/', '\\') }));
  const live = fileInstanceCounts(modelOf(FRONTMATTER + '<Div />\n'), {
    project: 'C:\\Sites\\project',
    path: 'C:\\Sites\\project\\src\\pages\\index.astro',
    components: windows,
  });
  assert.equal(live.file, 'src/pages/index.astro');
  assert.equal(live.counts.get(windows[0].path), 1);
});

const SCANNED_DIV = {
  ...DIV,
  instances: 3,
  uses: [
    { file: 'src/pages/index.astro', count: 1 },
    { file: 'src/pages/about.astro', count: 2 },
  ],
};

// One page through the edits a person makes, each a new tree; `total` is what the panel shows.
const TRANSITIONS = [
  { step: 'opened', body: '<main><Div /><p>Text</p></main>\n', total: 3 },
  { step: 'delete the instance', body: '<main><p>Text</p></main>\n', total: 2 },
  { step: 'undo', body: '<main><Div /><p>Text</p></main>\n', total: 3 },
  { step: 'redo', body: '<main><p>Text</p></main>\n', total: 2 },
  { step: 'undo again', body: '<main><Div /><p>Text</p></main>\n', total: 3 },
  { step: 'cut', body: '<main><p>Text</p></main>\n', total: 2 },
  { step: 'paste twice', body: '<main><p>Text</p><Div /><Div /></main>\n', total: 4 },
  { step: 'move into a slot', body: '<main><Card><Div /></Card><Div /></main>\n', total: 4 },
  { step: 'delete the parent holding one', body: '<main><Div /></main>\n', total: 3 },
  { step: 'delete the last one', body: '<main></main>\n', total: 2 },
];

test('the panel total follows every edit of the open page', () => {
  for (const row of TRANSITIONS) {
    const live = liveCounts(FRONTMATTER + row.body);
    const [shown] = withLiveInstances([SCANNED_DIV], [live]);
    assert.equal(shown.instances, row.total, row.step);
  }
});

test('a component the scan wrote no shares for keeps its count, and an unchanged list is the same list', () => {
  const live = liveCounts(FRONTMATTER + '<Div /><Div />\n');
  const older = [{ ...DIV, instances: 7 }];
  assert.equal(withLiveInstances(older, [live]), older, 'an older host: nothing to swap');
  const settled = [SCANNED_DIV];
  assert.equal(withLiveInstances(settled, [liveCounts(FRONTMATTER + '<Div />\n')]), settled, 'the live share equals the scanned one');
  assert.equal(withLiveInstances(settled, []), settled, 'no held file');
});

test('a file held twice is a programmer error', () => {
  const live = liveCounts(FRONTMATTER + '<Div />\n');
  assert.throws(() => withLiveInstances([SCANNED_DIV], [live, live]), /each file is held once/);
});

test('a stale scan never overwrites the open file: its share is always swapped out', () => {
  const live = liveCounts(FRONTMATTER + '<main></main>\n');
  // A scan that read index.astro before the delete was saved still lists it once.
  const stale = { ...SCANNED_DIV };
  // One that read it after lists it none.
  const fresh = { ...DIV, instances: 2, uses: [{ file: 'src/pages/about.astro', count: 2 }] };
  assert.equal(withLiveInstances([stale], [live])[0].instances, 2);
  assert.equal(withLiveInstances([fresh], [live])[0].instances, 2);
});

test('a left file is held until a scan that began after leaving it', () => {
  const index = liveCounts(FRONTMATTER + '<main></main>\n');
  const about = liveCounts(FRONTMATTER + '<Div /><Div />\n', '/project/src/pages/about.astro');
  let held = nextHeldFiles(new Map(), { current: index, appliedScan: 0, latestScan: 0 });
  assert.equal(held.get('src/pages/index.astro').leftAfter, undefined, 'the open file is held live');
  const repeat = nextHeldFiles(held, { current: index, appliedScan: 0, latestScan: 0 });
  assert.equal(repeat, held, 'a repeated render repeats its answer');

  const inFlight = scanBegin();
  held = nextHeldFiles(held, { current: about, appliedScan: 0, latestScan: scanSequenceLatest() });
  assert.equal(held.get('src/pages/index.astro').leftAfter, inFlight, 'leaving stamps the scans begun so far');
  assert.equal(held.get('src/pages/about.astro').leftAfter, undefined);

  // The scan that began before leaving lands: it may have read the old bytes, so the file stays held.
  held = nextHeldFiles(held, { current: about, appliedScan: inFlight, latestScan: scanSequenceLatest() });
  assert.ok(held.has('src/pages/index.astro'), 'an older scan keeps the left file held');
  const [shownStale] = withLiveInstances(
    [SCANNED_DIV],
    [...held.values()].map((entry) => entry.instances),
  );
  assert.equal(shownStale.instances, 2, 'index.astro counts none, about.astro two');

  // A scan that began after leaving read the saved file: the hold ends.
  const after = scanBegin();
  held = nextHeldFiles(held, { current: about, appliedScan: after, latestScan: scanSequenceLatest() });
  assert.equal(held.has('src/pages/index.astro'), false, 'a newer scan has the truth');
  assert.ok(held.has('src/pages/about.astro'), 'the open file stays held');
});

test('the shown scan cannot be newer than the scans begun', () => {
  assert.throws(() => nextHeldFiles(new Map(), { current: undefined, appliedScan: 5, latestScan: 4 }), /the shown scan has begun/);
});

test('held files are bounded', () => {
  let held = new Map();
  const total = HELD_FILES_MAX + 20;
  for (let index = 0; index < total; index += 1) {
    const current = { file: `src/pages/page-${index}.astro`, counts: new Map() };
    held = nextHeldFiles(held, { current, appliedScan: 0, latestScan: scanSequenceLatest() });
  }
  assert.equal(held.size, HELD_FILES_MAX);
  assert.ok(held.has(`src/pages/page-${total - 1}.astro`), 'the open file is never let go');
  assert.equal(held.has('src/pages/page-0.astro'), false, 'the longest-left goes first');
});

test('a scan is known by its components array, which a page-title patch keeps', () => {
  const components = [];
  const sequence = scanBegin();
  scanRecord(components, sequence);
  assert.equal(scanSequenceOf(components), sequence);
  assert.equal(scanSequenceOf([]), 0, 'a scan from before this window');
  assert.throws(() => scanRecord([], scanSequenceLatest() + 1), /a sequence was handed out/);
  assert.throws(() => scanRecord([], 0), /a sequence comes from scanBegin/);
});

// A wide, nested tree: 8,000 nodes, a quarter of them Div instances.
function bigTree(nodeCount) {
  const nodes = [];
  for (let index = 0; index < nodeCount; index += 4) {
    nodes.push({
      kind: 'element',
      name: 'section',
      children: [{ kind: 'component', name: 'Div', children: [{ kind: 'element', name: 'p', children: [{ kind: 'text', value: 'Words' }] }] }],
    });
  }
  return { imports: [{ name: 'Div', path: '../components/Div.astro', quote: "'" }], nodes };
}

function medianMs(run) {
  const samples = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return samples[3];
}

test('an 8,000-node page is counted in a frame, and the cost grows linearly', () => {
  const context = { project: PROJECT, path: PAGE, components: COMPONENTS };
  const small = bigTree(4000);
  const large = bigTree(8000);
  const live = fileInstanceCounts(large, context);
  assert.equal(live.counts.get(DIV.path), 2000);
  const largeMs = medianMs(() => withLiveInstances([SCANNED_DIV], [fileInstanceCounts(large, context)]));
  const smallMs = medianMs(() => withLiveInstances([SCANNED_DIV], [fileInstanceCounts(small, context)]));
  assert.ok(largeMs < 16, `8,000 nodes counted in ${largeMs.toFixed(2)} ms, within one frame`);
  // Twice the nodes, about twice the time; a quadratic walk would be four times.
  assert.ok(largeMs < Math.max(smallMs, 0.5) * 3.5, `linear: ${smallMs.toFixed(2)} ms for 4,000, ${largeMs.toFixed(2)} ms for 8,000`);
});

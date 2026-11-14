// Goal: every element switch in the Style panel paints complete states only. Between the
// previous element's finished panel and the next element's finished panel the chips, their
// highlight, the filter counts and the Typography labels never show a stage: no well without
// its picked chip, no previous element's chips offered as the new one's, no label that changes
// colour a frame later. A first-seen element whose classes the source cannot read draws a
// placeholder first; an element seen before under the same CSS paints at once from its last
// settled answer, and an edit in between is never painted stale.
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js).
// The fake canvas holds every reply and releases them FIFO, reversed or shuffled by seed, so
// each race order is replayed deterministically. A frame recorder samples a projection of the
// panel after every DOM mutation and animation frame; `directFailure` asserts the frames go
// straight to the final state, with placeholders allowed only before it. No pointer, no
// timing thresholds; the fixture is in memory.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, directFailure, fieldRow } = require('../../helpers/stylePanelHarness.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/base.css',
      css: [
        ':root { --display-font-weight: 600; --display-size: 3rem; }',
        ':target { scroll-margin-top: 2rem; }',
        ':focus-visible { outline: 2px solid blue; }',
        'h1 { font-size: 2rem; font-weight: 700; }',
        '[class*="text-"] { color: inherit; }',
        '.text-style-display { font-size: var(--display-size); line-height: 1.1; }',
        '.plain { color: red; }',
        '.card { padding: 1rem; }',
      ].join('\n'),
    },
    {
      rel: 'src/styles/patterns.css',
      css: '.heading { font-weight: var(--display-font-weight); letter-spacing: 0.01em; }\n.section .heading { margin-top: 0; }',
    },
  ],
  nodes: [
    {
      id: 'n0',
      kind: 'element',
      name: 'section',
      props: { class: { type: 'string', value: 'section' } },
      children: [
        { id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain card' } }, children: [] },
        { id: 'n2', kind: 'element', name: 'h1', props: { class: { type: 'string', value: 'heading text-style-display' } }, children: [] },
        // Classes written as an expression: the source cannot read them, only the canvas can.
        { id: 'n3', kind: 'element', name: 'h1', props: { class: { type: 'expr', value: 'cls' } }, children: [] },
        // The first class is styled nowhere, so the default pick moves on to `.heading`.
        { id: 'n4', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'u-anim heading' } }, children: [] },
      ],
    },
  ],
  markup: [
    '<section class="section" data-avb-p="n0">',
    '<p class="plain card" data-avb-p="n1">a</p>',
    '<h1 class="heading text-style-display" data-avb-p="n2">b</h1>',
    '<h1 class="heading text-style-display" data-avb-p="n3">c</h1>',
    '<h2 class="u-anim heading" data-avb-p="n4">d</h2>',
    '</section>',
  ].join(''),
  selectedId: 'n1',
};

// What a person sees of the switch: the well, its counts, and the Typography captions' colours.
function project(container) {
  const placeholder = container.querySelector('.embed-editor_selector-chips.is-placeholder') !== null;
  const chips = [...container.querySelectorAll('.embed-editor_selector-chip')].map(
    (chip) => `${chip.textContent.trim()}${chip.classList.contains('is-active') ? '*' : ''}[${chip.className}]`,
  );
  const filters = [...container.querySelectorAll('.embed-editor_selector-filter')].map((label) => label.textContent.trim());
  const sections = container.querySelectorAll('.embed-editor_decls .ui-skeleton').length > 0;
  const weight = fieldRow({ container }, 'Weight')?.querySelector('.u-field-label')?.className ?? '';
  return { placeholder, chips, filters, sections, weight };
}

const isPlaceholder = (frame) => frame.placeholder || frame.sections;

async function switchTo(panel, id, { order, seed }) {
  panel.bridge.mode = 'held';
  const recorder = recordFrames(panel, project);
  panel.select(id);
  await panel.settle();
  for (let round = 0; round < 64 && panel.bridge.held > 0; round += 1) {
    panel.bridge.release({ order, seed: seed + round, count: 1 });
    await panel.settle();
  }
  panel.bridge.mode = 'immediate';
  await panel.settle();
  return recorder.stop();
}

const ROUTE = ['n2', 'n1', 'n2', 'n3', 'n4', 'n2', 'n4', 'n3', 'n1'];

for (const order of ['fifo', 'reverse', 'shuffle']) {
  test(`every switch paints straight to its final state (${order})`, async (context) => {
    const panel = await mountStylePanel(FIXTURE);
    context.after(() => panel.unmount());
    const seen = new Set();
    for (const [step, id] of ROUTE.entries()) {
      const frames = await switchTo(panel, id, { order, seed: 11 + step });
      // One frame means nothing changed: the two elements look the same.
      const failure = frames.length === 1 ? undefined : directFailure(frames.slice(1), isPlaceholder);
      assert.equal(failure, undefined, `switch ${step} to ${id}: ${failure}`);
      const last = frames[frames.length - 1];
      assert.ok(
        last.chips.some((chip) => chip.includes('*')),
        `switch to ${id} ends with a picked chip`,
      );
      if (seen.has(id)) {
        assert.ok(
          frames.every((frame) => !isPlaceholder(frame)),
          `re-selecting ${id} paints from its last answer, with no placeholder`,
        );
      }
      seen.add(id);
    }
  });
}

test('an element whose source classes are unreadable shows a placeholder, never the previous chips', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await switchTo(panel, 'n4', { order: 'fifo', seed: 1 });
  const frames = await switchTo(panel, 'n3', { order: 'fifo', seed: 1 });
  const previous = JSON.stringify(frames[0].chips);
  for (const frame of frames.slice(1, -1)) {
    assert.ok(frame.placeholder, `a passing frame is the placeholder: ${JSON.stringify(frame)}`);
    assert.notEqual(JSON.stringify(frame.chips), previous, "the previous element's chips are not drawn as this one's");
    assert.ok(
      frame.filters.every((label) => !/\(\d+\)/.test(label)),
      `no count is drawn while pending: ${frame.filters}`,
    );
  }
});

test('a remembered answer is keyed by the CSS it was read against, and the memory is bounded', () => {
  const cache = loadRenderer('src/features/style/embed/scanSnapshotCache.ts');
  const sheetDocument = (key, code) => ({ source: { key }, code });
  const settled = { settled: true, awaitingFirstAnswer: false };
  const snapshot = { scan: settled, target: {}, classList: [], primed: undefined };
  const before = cache.scanSnapshotKey('n2', [sheetDocument('base', '.a { color: red }')]);
  cache.rememberScanSnapshot(before, snapshot);
  assert.equal(cache.readScanSnapshot(before), snapshot, 'the same CSS finds the answer');
  // An edit, an undo or a file changed outside the app changes a document's text.
  const after = cache.scanSnapshotKey('n2', [sheetDocument('base', '.a { color: blue }')]);
  assert.notEqual(after, before);
  assert.equal(cache.readScanSnapshot(after), undefined, 'changed CSS misses');
  assert.throws(() => cache.scanSnapshotKey('', []), /an element key is never empty/);
  assert.throws(() => cache.rememberScanSnapshot(before, { ...snapshot, scan: { settled: false, awaitingFirstAnswer: false } }), /only a settled answer/);
  for (let index = 0; index < cache.SCAN_SNAPSHOT_ENTRIES_MAX + 5; index += 1) {
    cache.rememberScanSnapshot(cache.scanSnapshotKey(`e${index}`, []), snapshot);
  }
  assert.equal(cache.readScanSnapshot(before), undefined, 'the oldest entries are dropped at the bound');
  assert.equal(cache.readScanSnapshot(cache.scanSnapshotKey(`e${cache.SCAN_SNAPSHOT_ENTRIES_MAX + 4}`, [])), snapshot, 'the newest are kept');
});

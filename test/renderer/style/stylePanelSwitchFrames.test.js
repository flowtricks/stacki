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

// ── Variable-connected rows across a switch between two connected elements ──
//
// Both elements set every Select-type typography property through a variable. The rows
// must show the chip, or the chip-shaped placeholder, in every frame: never the plain
// dropdown or input that a stage without the rule draws. Two pairs: one whose rules the
// source can see (the element's own classes), one only the page can match (an ancestor a
// component renders). The canvas answers at once, late, after its 1.5 s deadline, or
// never; elements are toggled A→B→A→B, with an undo in between.

const CONNECTED_ROWS = ['Font', 'Weight', 'Size', 'Height', 'Letter spacing'];
const connectedDeclarations = (suffix) =>
  `font-family: var(--f${suffix}); font-weight: var(--w${suffix}); font-size: var(--s${suffix}); line-height: var(--l${suffix}); letter-spacing: var(--t${suffix});`;
const CONNECTED = {
  sheets: [
    {
      rel: 'src/styles/base.css',
      css: [
        ':root { --fa: Inter; --wa: 600; --sa: 2rem; --la: 1.1; --ta: 0.01em; --fb: Lora; --wb: 700; --sb: 3rem; --lb: 1.2; --tb: 0.02em; }',
        `.own-a { ${connectedDeclarations('a')} }`,
        `.own-b { ${connectedDeclarations('b')} }`,
        `.section .deep-a { ${connectedDeclarations('a')} }`,
        `.section .deep-b { ${connectedDeclarations('b')} }`,
      ].join('\n'),
    },
  ],
  nodes: [
    { id: 'a', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'own-a' } }, children: [] },
    { id: 'b', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'own-b' } }, children: [] },
    {
      // A component renders the `.section` around its slot: the source cannot see it.
      id: 'wrap',
      kind: 'component',
      name: 'Section',
      props: {},
      children: [
        { id: 'da', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'deep-a' } }, children: [] },
        { id: 'db', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'deep-b' } }, children: [] },
      ],
    },
  ],
  markup: [
    '<h2 class="own-a" data-avb-p="a">a</h2><h2 class="own-b" data-avb-p="b">b</h2>',
    '<section class="section" data-avb-p="wrap"><h2 class="deep-a" data-avb-p="da">c</h2><h2 class="deep-b" data-avb-p="db">d</h2></section>',
  ].join(''),
  selectedId: 'a',
};

// Each connected row as a person sees it: its chip, a placeholder, or a plain editor.
function connectedRows(container) {
  const placeholder = container.querySelectorAll('.embed-editor_decls .ui-skeleton').length > 0;
  return Object.fromEntries(
    CONNECTED_ROWS.map((caption) => {
      if (placeholder) {
        return [caption, 'placeholder'];
      }
      // In the Typography section: the Size section has a Height of its own.
      const typography =
        [...container.querySelectorAll('.embed-editor_decls > *')].find((section) => /^\s*Typography/.test(section.textContent ?? '')) ?? container;
      const label = [...typography.querySelectorAll('.u-field-label, label')].find((element) => element.textContent.trim() === caption);
      let box = label?.parentElement ?? undefined;
      for (let depth = 0; box !== undefined && depth < 3 && box.querySelector('input, button.u-select-button, [data-chip]') === null; depth += 1) {
        box = box.parentElement ?? undefined;
      }
      if (box === undefined) {
        return [caption, 'missing'];
      }
      return [caption, box.querySelector('[data-chip]') === null ? 'plain' : 'chip'];
    }),
  );
}

const timers = require('node:timers');
const longWait = (milliseconds) => new Promise((resolve) => timers.setTimeout(resolve, milliseconds));

async function connectedSwitch(panel, id, timing) {
  panel.bridge.mode = timing === 'at once' ? 'immediate' : 'held';
  const recorder = recordFrames(panel, connectedRows);
  panel.select(id);
  await panel.settle();
  if (timing === 'late') {
    await longWait(200);
    panel.bridge.release({ order: 'shuffle', seed: 4 });
  } else if (timing === 'after its deadline') {
    await longWait(1600);
    panel.bridge.release({ order: 'reverse' });
  } else if (timing === 'never') {
    await longWait(1600);
  }
  await panel.settle();
  panel.bridge.mode = 'immediate';
  return recorder.stop();
}

for (const timing of ['at once', 'late', 'after its deadline', 'never']) {
  for (const [first, second, pageOnly] of [
    ['a', 'b', false],
    ['da', 'db', true],
  ]) {
    test(`connected rows never show a plain editor (${pageOnly ? 'page-only rules' : 'own rules'}, canvas answers ${timing})`, async (context) => {
      const panel = await mountStylePanel({ ...CONNECTED, selectedId: first });
      context.after(() => panel.unmount());
      // A rule only the page can match is unknowable without the canvas: when it never
      // answers, the source's answer (no rule) is the truth there is.
      const knowable = !pageOnly || timing === 'at once' || timing === 'late';
      for (const [step, id] of [second, first, second, first].entries()) {
        if (step === 2) {
          // An undo in between: the history moves and the panel re-reads.
          panel.rerender({ historyTick: (panel.props.historyTick ?? 0) + 1 });
          await panel.settle();
        }
        const frames = await connectedSwitch(panel, id, timing);
        const log = frames.map((frame) => Object.values(frame).join(','));
        if (knowable) {
          assert.ok(
            frames.every((frame) => Object.values(frame).every((kind) => kind === 'chip' || kind === 'placeholder')),
            `switch ${step} to ${id}: every frame is chips or a placeholder\n${log.join('\n')}`,
          );
          // A canvas that never answers leaves the element waiting in its placeholders: the
          // harness fires no deadline, and the previous element is never shown in its place.
          const ending = timing === 'never' ? ['chip', 'placeholder'] : ['chip'];
          assert.ok(
            Object.values(frames[frames.length - 1]).every((kind) => ending.includes(kind)),
            `and it ends on the chips${timing === 'never' ? ' or the wait for them' : ''}\n${log.join('\n')}`,
          );
        } else {
          assert.equal(
            // Nothing to know but the source's answer: the frames still go straight to it.
            frames.length === 1 ? undefined : directFailure(frames.slice(1), (frame) => Object.values(frame).includes('placeholder')),
            undefined,
            log.join('\n'),
          );
        }
      }
    });
  }
}

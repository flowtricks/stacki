// Goal: the Style panel never paints another selection's data. In every frame, the selector
// chips and the selected-element line either belong to the element the app has selected (the
// one its breadcrumb names, in the document it has open), or are the placeholders the panel
// draws while that element is being read. Never the previous element's chips, never a frame
// keyed to the same node id in another document.
//
// Why this exists: entering a component from one of its instances, and leaving it again,
// painted the previous element's chips first. Two causes. Node ids are tree paths, so the
// page's `p1` and the component's `p1` are different elements under one id, and the panel
// keyed what it showed by the id alone: an id shared across the switch kept the previous
// document's chips, and the remembered answer for `p1` on the page was offered for `p1` in
// the component. And the switch hold kept the previous element on screen while the app had
// already selected the next one, so for as long as its answer took (up to 1.5 s when the
// canvas loads another document) the chips belonged to an element the breadcrumb had left.
//
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js),
// with the fake canvas holding every reply until the test releases it. Each element in the
// fixture carries one class no other element has (its marker). A recorder samples, after every
// DOM mutation and every animation frame, the chips, the element line and the selection the app
// holds at that moment; a frame fails when it shows a marker of an element other than the
// selected one. The steps cover selecting A then B on a page, entering a component instance's
// inner element (with an id the page also has, and with one it does not), leaving back to the
// page, rapid arrow-key style navigation without waiting for answers, and undo/redo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, settle } = require('../../helpers/stylePanelHarness.js');

const PAGE_FILE = '/fixture/src/pages/index.astro';
const COMPONENT_FILE = '/fixture/src/components/Button.astro';

const SHEETS = [
  {
    rel: 'src/styles/base.css',
    css: [
      '.page_wrap { padding: 1rem; }',
      '.alpha { color: red; }',
      '.beta { color: blue; }',
      '.gamma { margin: 0; }',
      '.button_wrap { display: flex; }',
      '.button_text { font-weight: 600; }',
      '.button_icon { width: 1rem; }',
    ].join('\n'),
  },
];

const element = (id, name, className, children = []) => ({ id, kind: 'element', name, props: { class: { type: 'string', value: className } }, children });

const PAGE = {
  file: PAGE_FILE,
  kind: 'page',
  nodes: [
    element('p0', 'section', 'page_wrap', [
      element('p1', 'h2', 'alpha'),
      element('p2', 'p', 'beta'),
      element('p3', 'div', 'gamma'),
      { id: 'p4', kind: 'component', name: 'Button', props: {}, children: [] },
    ]),
  ],
  markup:
    '<section class="page_wrap" data-avb-p="p0"><h2 class="alpha" data-avb-p="p1">a</h2><p class="beta" data-avb-p="p2">b</p>' +
    '<div class="gamma" data-avb-p="p3">c</div><button class="button_wrap" data-avb-p="p4"><span class="button_text">Go</span></button></section>',
};

// The component's ids are tree paths of its own file: `p1` here is the label, `p1` on the page is the heading.
const COMPONENT = {
  file: COMPONENT_FILE,
  kind: 'component',
  nodes: [element('p0', 'button', 'button_wrap', [element('p1', 'span', 'button_text'), element('c2', 'i', 'button_icon')])],
  markup: '<button class="button_wrap" data-avb-p="p0"><span class="button_text" data-avb-p="p1">Go</span><i class="button_icon" data-avb-p="c2"></i></button>',
};

// Each selection's own class: no other element in the fixture has it.
const MARKERS = new Map([
  [`${PAGE_FILE}#p0`, 'page_wrap'],
  [`${PAGE_FILE}#p1`, 'alpha'],
  [`${PAGE_FILE}#p2`, 'beta'],
  [`${PAGE_FILE}#p3`, 'gamma'],
  [`${PAGE_FILE}#p4`, 'button_wrap'],
  [`${COMPONENT_FILE}#p0`, 'button_wrap'],
  [`${COMPONENT_FILE}#p1`, 'button_text'],
  [`${COMPONENT_FILE}#c2`, 'button_icon'],
]);
const ALL_MARKERS = [...new Set(MARKERS.values())];

const selectionKey = (props) => `${props.openFilePath}#${props.node?.id ?? ''}`;

// What a frame shows, with the selection the app held when it was painted.
function projectFor(panel) {
  return (container) => {
    const well = container.querySelector('.embed-editor_selector-chips');
    const placeholder = well === null || well.classList.contains('is-placeholder');
    const chips = placeholder ? [] : [...container.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent.trim());
    const line = container.querySelector('.embed-editor_selector-box')?.textContent.trim() ?? '';
    return { selection: selectionKey(panel.props), placeholder, chips, line };
  };
}

// The markers a frame shows that are not the selected element's own.
function foreignMarkers(frame) {
  const own = MARKERS.get(frame.selection);
  assert.ok(own !== undefined, `the fixture names a marker for ${frame.selection}`);
  const shown = [...frame.chips, frame.line].join(' ');
  return ALL_MARKERS.filter((marker) => marker !== own && new RegExp(`\\b${marker}\\b`).test(shown));
}

function assertNoForeignFrame(frames, label) {
  for (const [index, frame] of frames.entries()) {
    const foreign = foreignMarkers(frame);
    assert.deepEqual(foreign, [], `${label}: frame ${index} shows ${foreign.join(', ')} while ${frame.selection} is selected: ${JSON.stringify(frame)}`);
  }
}

// Selects `id` in `document`, as the app does: a document change swaps the tree, the open file
// and the canvas's page in one render; the rendered classes are reported a moment later.
function selectIn(panel, document, id) {
  if (panel.props.openFilePath !== document.file) {
    panel.page.window.document.body.innerHTML = document.markup;
    panel.rerender({
      model: { nodes: document.nodes },
      openFilePath: document.file,
      openFileKind: document.kind,
      contextPagePath: document.kind === 'component' ? PAGE_FILE : undefined,
      node: { id },
      renderedClasses: [],
      renderedClassesKnown: false,
    });
    panel.bridge.enqueue(`classes report for ${id}`, () => {
      if (panel.props.node.id === id && panel.props.openFilePath === document.file) {
        const rendered = panel.page.window.document.querySelector(`[data-avb-p="${id}"]`);
        panel.rerender({ renderedClasses: rendered ? [...rendered.classList] : [], renderedClassesKnown: true });
      }
    });
    panel.noteRendered();
    return;
  }
  panel.select(id);
}

async function releaseAll(panel, order) {
  for (let round = 0; round < 64 && panel.bridge.held > 0; round += 1) {
    panel.bridge.release({ order, seed: 7 + round, count: 1 });
    await panel.settle();
  }
  panel.bridge.mode = 'immediate';
  await panel.settle();
}

async function step(panel, document, id, order) {
  panel.bridge.mode = 'held';
  const recorder = recordFrames(panel, projectFor(panel));
  selectIn(panel, document, id);
  await panel.settle();
  await releaseAll(panel, order);
  return recorder.stop();
}

const ROUTE = [
  [PAGE, 'p2', 'select B on the page'],
  [PAGE, 'p4', 'select the instance'],
  [COMPONENT, 'p1', 'enter the component at an id the page also has'],
  [PAGE, 'p1', 'leave to the page at the same id'],
  [COMPONENT, 'c2', 'enter the component at an id only it has'],
  [COMPONENT, 'p0', 'select the component root'],
  [PAGE, 'p4', 'leave to the instance'],
  [PAGE, 'p3', 'select C on the page'],
];

for (const order of ['fifo', 'reverse']) {
  test(`no frame shows another selection's chips (${order})`, async (context) => {
    const panel = await mountStylePanel({ sheets: SHEETS, nodes: PAGE.nodes, markup: PAGE.markup, selectedId: 'p1' });
    context.after(() => panel.unmount());
    for (const [document, id, label] of ROUTE) {
      const frames = await step(panel, document, id, order);
      assertNoForeignFrame(frames, label);
      const last = frames[frames.length - 1];
      assert.equal(last.placeholder, false, `${label}: the well ends with chips, not a placeholder`);
      assert.ok(
        last.chips.includes(`.${MARKERS.get(last.selection)}`),
        `${label}: the well ends with the selected element's own chip: ${JSON.stringify(last)}`,
      );
    }
  });
}

test('rapid navigation never paints a chip of an element passed over', async (context) => {
  const panel = await mountStylePanel({ sheets: SHEETS, nodes: PAGE.nodes, markup: PAGE.markup, selectedId: 'p0' });
  context.after(() => panel.unmount());
  panel.bridge.mode = 'held';
  const recorder = recordFrames(panel, projectFor(panel));
  // Arrow keys in the navigator: one selection per key press, faster than the canvas answers.
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p3', 'p2']) {
    panel.select(id);
    await settle(panel.container);
    panel.bridge.release({ order: 'fifo', count: 1 });
  }
  await releaseAll(panel, 'shuffle');
  const frames = recorder.stop();
  assertNoForeignFrame(frames, 'rapid navigation');
  assert.ok(frames[frames.length - 1].chips.includes('.beta'), 'it ends on the last element selected');
});

test('undo and redo never paint another selection', async (context) => {
  const panel = await mountStylePanel({ sheets: SHEETS, nodes: PAGE.nodes, markup: PAGE.markup, selectedId: 'p1' });
  context.after(() => panel.unmount());
  await step(panel, COMPONENT, 'p1', 'fifo');
  for (const label of ['undo', 'redo']) {
    panel.bridge.mode = 'held';
    const recorder = recordFrames(panel, projectFor(panel));
    panel.rerender({ historyTick: (panel.props.historyTick ?? 0) + 1 });
    await panel.settle();
    await releaseAll(panel, 'reverse');
    const frames = recorder.stop();
    assertNoForeignFrame(frames, label);
    assert.ok(frames[frames.length - 1].chips.includes('.button_text'), `${label}: the component's label keeps its chips`);
  }
});

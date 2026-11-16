// Goal: the breakpoint / media-query dropdown trigger in the Style panel is steady when the
// selection moves from one element to another, and carries the Follow canvas size toggle.
//   - Across an element switch the trigger never paints a wrong label in between (Base, or empty)
//     on its way to the right one: while the new element is still being read, the old target stays.
//   - The pin on the trigger is always there, a toggle (aria-pressed) that follows or holds the
//     canvas width without opening the list.
//   - A breakpoint target tints the trigger (is-query); Base keeps the plain look.
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js)
// with two elements styled by min-width queries, the canvas at a width inside the 48rem query.
// The fake canvas holds every reply and releases them one at a time, so each stage of a switch
// is a frame the recorder can see. Everything is dispatched events; the project path is fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, press } = require('../../helpers/stylePanelHarness.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/patterns.css',
      css: [
        '.grid { @media (width >= 30rem) { gap: 1rem; } @media (width >= 48rem) { gap: 2rem; } @media (width >= 64rem) { gap: 3rem; } }',
        '.grid .item { @media (width >= 48rem) { padding: 2rem; } }',
        '.plain { color: red; }',
      ].join('\n'),
    },
  ],
  nodes: [
    {
      id: 'n1',
      kind: 'element',
      name: 'div',
      props: { class: { type: 'string', value: 'grid' } },
      children: [
        { id: 'n2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'item' } }, children: [] },
        { id: 'n3', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'plain' } }, children: [] },
      ],
    },
  ],
  markup: '<div class="grid" data-avb-p="n1"><div class="item" data-avb-p="n2">b</div><div class="plain" data-avb-p="n3">c</div></div>',
  selectedId: 'n1',
};

let counter = 0;
async function mount(widthPx) {
  const panel = await mountStylePanel(FIXTURE);
  counter += 1;
  panel.rerender({ project: { path: `/fixture-trigger-${counter}` }, canvasWidthPx: widthPx, onCanvasWidth: () => {}, onDesktopCanvas: () => {} });
  await panel.settle();
  return panel;
}

const select = (panel) => panel.container.querySelector('.embed-editor_context-select');
const trigger = (panel) => select(panel).querySelector('.u-select-button');
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const pin = (panel) => trigger(panel).querySelector('.u-select-pin');
const projectTrigger = (container) => {
  const button = container.querySelector('.embed-editor_context-select .u-select-button');
  return button === null ? 'no trigger' : text(button);
};

async function switchTo(panel, id) {
  panel.bridge.mode = 'held';
  const recorder = recordFrames(panel, projectTrigger);
  panel.select(id);
  await panel.settle();
  for (let round = 0; round < 64 && panel.bridge.held > 0; round += 1) {
    panel.bridge.release({ order: 'fifo', seed: round, count: 1 });
    await panel.settle();
  }
  panel.bridge.mode = 'immediate';
  await panel.settle();
  return recorder.stop();
}

test('switching elements while following never paints Base or an empty trigger on the way', async (context) => {
  const panel = await mount(1000);
  context.after(() => panel.unmount());
  const before = text(trigger(panel));
  assert.match(before, /≥ 48rem/, '1000px is inside the 48rem query');
  for (const id of ['n2', 'n1', 'n2', 'n1']) {
    const frames = await switchTo(panel, id);
    for (const frame of frames) {
      assert.match(frame, /≥ 48rem/, `switch to ${id}: a frame showed "${frame}" instead of the target that holds at the canvas width`);
    }
  }
});

test('switching elements while held keeps the held target in every frame', async (context) => {
  const panel = await mount(1000);
  context.after(() => panel.unmount());
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  assert.equal(pin(panel).getAttribute('aria-pressed'), 'false', 'the first press holds');
  const held = text(trigger(panel));
  for (const id of ['n2', 'n1']) {
    const frames = await switchTo(panel, id);
    for (const frame of frames) {
      assert.match(frame, /≥ 48rem/, `switch to ${id}: a frame showed "${frame}" instead of the held ${held}`);
    }
  }
});

test('the trigger carries the Follow canvas size toggle, pressed while following', async (context) => {
  const panel = await mount(1000);
  context.after(() => panel.unmount());
  assert.ok(pin(panel), 'the pin is on the closed trigger while following');
  assert.equal(pin(panel).getAttribute('aria-pressed'), 'true');
  assert.equal(pin(panel).getAttribute('title') === null, true, 'the tooltip is the app tooltip, not a native title');
  assert.equal(pin(panel).getAttribute('aria-label'), 'Follow canvas size');
  assert.equal([...select(panel).querySelectorAll('[role="switch"]')].length, 0, 'the closed trigger has no switch; the list row is gone too (checked below)');
  const shown = text(trigger(panel));
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  assert.equal(pin(panel).getAttribute('aria-pressed'), 'false', 'pressing it holds the target');
  assert.equal(text(trigger(panel)), shown, 'holding keeps the target where it is');
  assert.equal(document.querySelector('.embed-editor_context-select .u-select-list') === null, true, 'and never opened the list');
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  assert.equal(pin(panel).getAttribute('aria-pressed'), 'true', 'pressing it again follows');
});

test('a breakpoint target tints the trigger; Base keeps the plain look', async (context) => {
  const panel = await mount(1000);
  context.after(() => panel.unmount());
  assert.ok(select(panel).classList.contains('is-query'), 'a breakpoint is the target');
  panel.rerender({ canvasWidthPx: 300 });
  await panel.settle();
  assert.equal(text(trigger(panel)).includes('rem'), false, 'under the smallest query the target is Base');
  assert.ok(!select(panel).classList.contains('is-query'), 'Base is not tinted');
  assert.ok(press, 'the harness press helper is present');
});

test('the list has no Follow canvas size row: the trigger toggle is the only control', async (context) => {
  const panel = await mount(1000);
  context.after(() => panel.unmount());
  await panel.user('open the list', () => press(panel, trigger(panel)));
  const list = document.querySelector('.embed-editor_context-select .u-select-list');
  assert.ok(list, 'the list opened');
  assert.equal(list.querySelectorAll('[role="switch"]').length, 0, 'no switch in the list');
  assert.equal(text(list).includes('Follow canvas size'), false, 'and no row naming it');
});

test('a following panel retargets only once the element has been read', async () => {
  const { followRetargetKey } = loadRenderer('src/features/style/embed/contextFollow.ts');
  const state = { following: true, settled: true, matchedKey: 'bp:tablet', context: 'bp:laptop' };
  assert.equal(followRetargetKey(state), 'bp:tablet', 'settled and different: move');
  assert.equal(followRetargetKey({ ...state, settled: false }), undefined, "the element is still being read: stay, so no frame shows the partial list's row");
  assert.equal(followRetargetKey({ ...state, following: false }), undefined, 'held: stay');
  assert.equal(followRetargetKey({ ...state, matchedKey: undefined }), undefined, 'no canvas width: stay');
  assert.equal(followRetargetKey({ ...state, context: 'bp:tablet' }), undefined, 'already there: no move');
});

// Goal: the style panel's edit target follows the canvas width, can be unchecked to edit every
// size without moving the canvas, and stays out of the way of the open list.
//   - the query that holds at the canvas width is the target (trigger and checked row), and
//     it changes as the width changes, with no file write and no canvas move;
//   - unchecking the matched row pins the target to Base WITHOUT moving the canvas; a pinned
//     target survives canvas resizes; checking the matched row again follows again;
//   - choosing Base by hand still moves the canvas (one pixel under the smallest query) and pins;
//   - an open list stays open, and checks the new row in place, while the width changes.
// Method: the real StylePanel through the shared harness over one stylesheet with three
// min-width queries on `.grid`. Widths arrive as the `canvasWidthPx` prop (what the preview
// reports); the canvas action is a spy. Everything is dispatched events; the list is read
// from the DOM. No pointer, no timing, no real project (the project path is fake and unique
// per test, so one test's pin never leaks into the next).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/patterns.css',
      css: '.grid { @media (width >= 30rem) { gap: 1rem; } @media (width >= 48rem) { gap: 2rem; } @media (width >= 64rem) { gap: 3rem; } }',
    },
  ],
  nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] }],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
};

let counter = 0;
async function mount(widthPx) {
  const panel = await mountStylePanel(FIXTURE);
  const canvasRequests = [];
  counter += 1;
  panel.rerender({
    project: { path: `/fixture-follow-${counter}` },
    canvasWidthPx: widthPx,
    onCanvasWidth: (width) => canvasRequests.push(width),
    onDesktopCanvas: () => canvasRequests.push('desktop'),
  });
  await panel.settle();
  return { panel, canvasRequests };
}

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const list = () => document.querySelector('.embed-editor_context-select .u-select-list') ?? undefined;
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const shown = (panel) => text(trigger(panel));
const checkedRow = () => text(list().querySelector('[role="option"][aria-selected="true"]'));
const row = (label) => [...list().querySelectorAll('[role="option"]')].find((candidate) => text(candidate).startsWith(label));
const open = (panel) => panel.user('open the dropdown', () => press(panel, trigger(panel)));
const resizeTo = (panel, widthPx) => panel.data(`canvas ${widthPx}px`, () => panel.rerender({ canvasWidthPx: widthPx }));

test('the target follows the canvas width, with no write and no canvas move', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  assert.match(shown(panel), /width >= 48rem/, '1000px is inside the 48rem query');
  await resizeTo(panel, 1100);
  assert.match(shown(panel), /width >= 64rem/);
  await resizeTo(panel, 480);
  assert.match(shown(panel), /width >= 30rem/, 'the boundary pixel itself holds');
  await resizeTo(panel, 479);
  assert.equal(shown(panel), 'Base', 'one pixel under the smallest query is Base');
  assert.deepEqual(panel.writes, [], 'following writes nothing');
  assert.deepEqual(canvasRequests, [], 'and never moves the canvas');
});

test('unchecking the matched row edits every size: Base, canvas where it was, pinned through resizes', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  assert.match(checkedRow(), /width >= 48rem/, 'the matched row is the checked one');
  await panel.user('uncheck the matched row', () => press(panel, row('@media (width >= 48rem)')));
  assert.equal(shown(panel), 'Base', 'the target is Base');
  assert.deepEqual(canvasRequests, [], 'the canvas did not move: uncheck is not a click on Base');
  assert.ok(trigger(panel).querySelector('.u-select-mark'), 'the trigger says it is pinned');
  await resizeTo(panel, 1300);
  assert.equal(shown(panel), 'Base', 'a pinned target ignores canvas resizes');
  await resizeTo(panel, 500);
  assert.equal(shown(panel), 'Base');
  assert.deepEqual(canvasRequests, []);
  assert.deepEqual(panel.writes, []);
});

test('checking the matched row again follows again, without moving the canvas', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  await panel.user('uncheck', () => press(panel, row('@media (width >= 48rem)')));
  await resizeTo(panel, 1100);
  await open(panel);
  assert.equal(checkedRow(), 'Base', 'pinned: Base is checked, not the row that holds');
  await panel.user('check the matching row', () => press(panel, row('@media (width >= 64rem)')));
  assert.match(shown(panel), /width >= 64rem/);
  assert.ok(trigger(panel).querySelector('.u-select-mark') === null, 'no pin once following');
  assert.deepEqual(canvasRequests, [], 'the canvas is already inside that query');
  await resizeTo(panel, 500);
  assert.match(shown(panel), /width >= 30rem/, 'and the target follows again');
});

test('choosing Base by hand moves the canvas under the smallest query and pins', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  await panel.user('click Base', () => press(panel, row('Base')));
  assert.deepEqual(canvasRequests, [479], 'Base lands one pixel under 30rem');
  assert.equal(shown(panel), 'Base');
  assert.ok(trigger(panel).querySelector('.u-select-mark'), 'a choice is pinned');
  await resizeTo(panel, 479);
  await resizeTo(panel, 1100);
  assert.equal(shown(panel), 'Base', 'and stays pinned while the canvas moves');
});

test('choosing another query pins to it, and moves the canvas inside it', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  await panel.user('pick 30rem', () => press(panel, row('@media (width >= 30rem)')));
  assert.deepEqual(canvasRequests, [480]);
  await resizeTo(panel, 1100);
  assert.match(shown(panel), /width >= 30rem/, 'the choice is held through a resize');
});

test('an open list stays open and checks the new row in place while the canvas is resized', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  const element = list();
  assert.match(checkedRow(), /width >= 48rem/);
  await resizeTo(panel, 1100);
  assert.equal(list(), element, 'the same list, not a reopened one');
  assert.match(checkedRow(), /width >= 64rem/, 'the checked row moved');
  await resizeTo(panel, 300);
  assert.equal(list(), element);
  assert.equal(checkedRow(), 'Base');
  assert.deepEqual(panel.popovers.spontaneousCloses(), [], 'the list closed only by a person');
  assert.deepEqual(canvasRequests, []);
  assert.deepEqual(panel.writes, []);
});

test('with no known canvas width nothing follows, and a pick is not pinned', async (context) => {
  const { panel } = await mount(undefined);
  context.after(() => panel.unmount());
  assert.equal(shown(panel), 'Base');
  await open(panel);
  await panel.user('pick 48rem', () => press(panel, row('@media (width >= 48rem)')));
  assert.ok(trigger(panel).querySelector('.u-select-mark') === null);
});

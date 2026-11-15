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
// from the DOM. A stale pin kept by an earlier version is planted in storage before a project
// opens, and must be ignored and deleted. No pointer, no timing, no real project (the project path is fake and unique
// per test, so one test's pin never leaks into the next).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press, key } = require('../../helpers/stylePanelHarness.js');

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
const checkedRow = () => text(list().querySelector('.u-select-scroll [role="option"][aria-selected="true"]'));
const row = (label) => [...list().querySelectorAll('[role="option"]')].find((candidate) => text(candidate).startsWith(label));
const open = (panel) => panel.user('open the dropdown', () => press(panel, trigger(panel)));
const resizeTo = (panel, widthPx) => panel.data(`canvas ${widthPx}px`, () => panel.rerender({ canvasWidthPx: widthPx }));

test('the target follows the canvas width, with no write and no canvas move', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  assert.match(shown(panel), /≥ 48rem/, '1000px is inside the 48rem query');
  await resizeTo(panel, 1100);
  assert.match(shown(panel), /≥ 64rem/);
  await resizeTo(panel, 480);
  assert.match(shown(panel), /≥ 30rem/, 'the boundary pixel itself holds');
  await resizeTo(panel, 479);
  assert.equal(shown(panel), 'Base', 'one pixel under the smallest query is Base');
  assert.deepEqual(panel.writes, [], 'following writes nothing');
  assert.deepEqual(canvasRequests, [], 'and never moves the canvas');
});

test('unchecking the matched row edits every size: Base, canvas where it was, pinned through resizes', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  assert.match(checkedRow(), /≥ 48rem/, 'the matched row is the checked one');
  await panel.user('uncheck the matched row', () => press(panel, row('≥ 48rem')));
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
  await panel.user('uncheck', () => press(panel, row('≥ 48rem')));
  await resizeTo(panel, 1100);
  await open(panel);
  assert.equal(checkedRow(), 'Base', 'pinned: Base is checked, not the row that holds');
  await panel.user('check the matching row', () => press(panel, row('≥ 64rem')));
  assert.match(shown(panel), /≥ 64rem/);
  assert.ok(trigger(panel).querySelector('.u-select-mark') === null, 'no pin once following');
  assert.deepEqual(canvasRequests, [], 'the canvas is already inside that query');
  await resizeTo(panel, 500);
  assert.match(shown(panel), /≥ 30rem/, 'and the target follows again');
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
  await panel.user('pick 30rem', () => press(panel, row('≥ 30rem')));
  assert.deepEqual(canvasRequests, [480]);
  await resizeTo(panel, 1100);
  assert.match(shown(panel), /≥ 30rem/, 'the choice is held through a resize');
});

test('an open list stays open and checks the new row in place while the canvas is resized', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  const element = list();
  assert.match(checkedRow(), /≥ 48rem/);
  await resizeTo(panel, 1100);
  assert.equal(list(), element, 'the same list, not a reopened one');
  assert.match(checkedRow(), /≥ 64rem/, 'the checked row moved');
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
  await panel.user('pick 48rem', () => press(panel, row('≥ 48rem')));
  assert.ok(trigger(panel).querySelector('.u-select-mark') === null);
});

const STALE_KEY = (path) => `stacki.styleContext:${path}`;

test('a fresh session follows even when an old stored pin exists, and the old record is deleted', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  counter += 1;
  const project = `/fixture-follow-${counter}`;
  // The harness page has no origin, so jsdom refuses its storage: a small stand-in.
  const stored = new Map([[STALE_KEY(project), '{"follow":false}']]);
  Object.defineProperty(panel.window, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
  });
  panel.rerender({ project: { path: project }, canvasWidthPx: 1000 });
  await panel.settle();
  assert.match(shown(panel), /≥ 48rem/, 'it follows: the stored pin is not read');
  assert.ok(trigger(panel).querySelector('.u-select-mark') === null);
  assert.equal(stored.has(STALE_KEY(project)), false, 'and the stale record is gone');
});

test('the Follow canvas size switch heads the list: on while following, off when held, on again when checked', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  const strip = list().querySelector(':scope > .u-select-header');
  assert.ok(strip !== null, 'the strip is pinned at the top, outside the scrolling rows');
  assert.ok(strip.querySelector('[role="switch"]'), 'drawn with the app switch');
  assert.ok(strip.querySelector('.u-select-check svg') === null, 'with no check mark');
  assert.equal(row('Follow canvas size').getAttribute('aria-selected'), 'true', 'on by default');
  const element = list();
  await panel.user('switch it off', () => press(panel, row('Follow canvas size')));
  assert.equal(list(), element, 'the list stays open while the switch changes');
  assert.equal(row('Follow canvas size').getAttribute('aria-selected'), 'false');
  assert.match(shown(panel), /≥ 48rem/, 'holding keeps the target where it is');
  assert.ok(trigger(panel).querySelector('.u-select-mark'), 'and the trigger shows the pin');
  await resizeTo(panel, 1100);
  assert.match(shown(panel), /≥ 48rem/, 'a held target ignores the resize');
  assert.equal(list(), element, 'and the open list is not disturbed');
  await panel.user('switch it on', () => press(panel, row('Follow canvas size')));
  assert.match(shown(panel), /≥ 64rem/, 'following resumes at the canvas width, in place');
  assert.equal(row('Follow canvas size').getAttribute('aria-selected'), 'true');
  assert.deepEqual(canvasRequests, [], 'none of it moved the canvas');
});

test('Space on the switch row toggles it from the keyboard', async (context) => {
  const { panel } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  await panel.user('arrow up to the strip', () => key(panel, list(), 'Home'));
  assert.equal(list().querySelector('[data-active="true"]').parentElement.className, 'u-select-header');
  await panel.user('Space', () => key(panel, list(), ' '));
  assert.equal(row('Follow canvas size').getAttribute('aria-selected'), 'false');
  assert.ok(list() !== undefined, 'still open');
});

test('the pin on the trigger lets go of the hold', async (context) => {
  const { panel, canvasRequests } = await mount(1000);
  context.after(() => panel.unmount());
  await open(panel);
  await panel.user('uncheck the matched row', () => press(panel, row('≥ 48rem')));
  assert.equal(shown(panel), 'Base');
  const pin = trigger(panel).querySelector('.u-select-pin');
  assert.equal(pin.title, 'Follow canvas size');
  await panel.user('press the pin', () => press(panel, pin));
  assert.match(shown(panel), /≥ 48rem/, 'following again');
  assert.ok(list() === undefined, 'the press on the pin did not open the list');
  assert.deepEqual(canvasRequests, []);
});

test('each breakpoint width the preview can report moves the checked row', async (context) => {
  const { panel } = await mount(1280);
  context.after(() => panel.unmount());
  // Desktop (fluid), laptop, tablet, phone: the default breakpoints' canvas widths, then a custom one.
  const expected = [
    [1280, /≥ 64rem/],
    [1023, /≥ 48rem/],
    [767, /≥ 30rem/],
    [479, /^Base$/],
    [640, /≥ 30rem/],
    [1280, /≥ 64rem/],
  ];
  for (const [width, pattern] of expected) {
    await resizeTo(panel, width);
    assert.match(shown(panel), pattern, `${width}px`);
  }
});

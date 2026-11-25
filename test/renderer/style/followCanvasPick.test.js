// Goal: the two Follow canvas size behaviours the person asked for, in the real Style panel with the
// real breakpoint dropdown, against a canvas whose size answers the panel the way Desktop's does.
//   1. Following on a query (the canvas on Tablet, 767px), the "0" key or the link on the trigger turns
//      following off and the target to Base, and the canvas keeps its width and device: the person
//      edits Base while looking at the small canvas. Again, it follows again onto the canvas's query.
//      Following on Base, it only turns following off.
//   2. Following, a breakpoint row clicked (or chosen with the arrow keys and Enter) in the list moves
//      the canvas to that breakpoint's width and keeps following; the row the canvas is already on
//      moves nothing; a row with no canvas width (`prefers-reduced-motion`) is held, the canvas stays.
// Both a desktop-first (`width < X`) and a mobile-first (`width >= X`, the reported list) fixture.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel. The
// canvas is a small state machine like Desktop's window state (appState.ts): the panel's width
// request makes the device `custom` at that width, its Desktop request makes it `desktop`; the new
// width is reported back as the `canvasWidthPx` prop, one data step later, as the preview reports it.
// The device the toolbar shows pressed is the real activeDeviceFor. Each action is recorded frame by
// frame (every DOM mutation and animation frame) as the trigger's label and link state, and must go
// straight from the old picture to the new one: no flicker through a passing state. Dispatched events
// only; the project path is fake and unique per test; nothing touches a real project.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, press, key } = require('../../helpers/stylePanelHarness.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const { activeDeviceFor } = loadRenderer('shared/properties/breakpointIcon.ts');
const { BREAKPOINT_DEFAULTS } = loadRenderer('shared/properties/projectBreakpoints.ts');

const DESKTOP_WIDTH_PX = 1440;
const deviceWidthPx = (id) => BREAKPOINT_DEFAULTS.find((breakpoint) => breakpoint.id === id).widthPx;

const node = { id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] };
const fixture = (css) => ({
  sheets: [{ rel: 'src/styles/patterns.css', css }],
  nodes: [node],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
});
const MOTION = '@media (prefers-reduced-motion: reduce) { .grid { transition: none; } }';
const FIXTURES = {
  desktopFirst: fixture(
    `.grid { gap: 3rem; @media (width < 64rem) { gap: 2rem; } @media (width < 48rem) { gap: 1.5rem; } @media (width < 30rem) { gap: 1rem; } }\n${MOTION}`,
  ),
  mobileFirst: fixture(
    `.grid { @media (width >= 30rem) { gap: 1rem; } @media (width >= 48rem) { gap: 2rem; } @media (width >= 64rem) { gap: 3rem; } }\n${MOTION}`,
  ),
};

let counter = 0;
// Mounts the panel over a canvas on `device` at `widthPx`, which answers the panel's own requests.
async function mount(name, device, widthPx) {
  const panel = await mountStylePanel(FIXTURES[name]);
  const canvas = { device, widthPx, requests: [] };
  const report = (nextDevice, nextWidthPx) => {
    canvas.device = nextDevice;
    canvas.widthPx = nextWidthPx;
    // The preview reports its new width after it has drawn it, a moment later.
    setTimeout(() => panel.rerender({ device: canvas.device, canvasWidthPx: canvas.widthPx }), 0);
  };
  counter += 1;
  panel.rerender({
    project: { path: `/fixture-follow-pick-${counter}` },
    device,
    canvasWidthPx: widthPx,
    onCanvasWidth: (width) => {
      canvas.requests.push(width);
      report('custom', width);
    },
    onDesktopCanvas: () => {
      canvas.requests.push('desktop');
      report('desktop', DESKTOP_WIDTH_PX);
    },
  });
  await panel.settle();
  return { panel, canvas };
}

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const link = (panel) => trigger(panel).querySelector('.u-select-pin');
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const label = (panel) => text(trigger(panel));
const following = (panel) => link(panel).getAttribute('aria-pressed') === 'true';
const options = () => [...document.querySelectorAll('.embed-editor_context-select .u-select-list [role="option"]')];
const option = (start) => options().find((candidate) => text(candidate).startsWith(start));
const pressedDevice = (canvas) => activeDeviceFor(canvas.device, canvas.widthPx, BREAKPOINT_DEFAULTS);
const picture = (container) => {
  const button = container.querySelector('.embed-editor_context-select .u-select-button');
  if (button === null) {
    return 'no trigger';
  }
  const pin = button.querySelector('.u-select-pin');
  return `${text(button)} | ${pin?.getAttribute('aria-pressed') === 'true' ? 'following' : 'held'}`;
};

// Runs `action` as a user step, recording the trigger's pictures, and returns the distinct ones.
async function recorded(panel, name, action) {
  const recorder = recordFrames(panel, picture);
  await panel.user(name, action);
  await panel.settle();
  return recorder.stop();
}

async function openList(panel) {
  await panel.user('open the list', () => press(panel, trigger(panel)));
  assert.ok(options().length > 0, 'the list is open');
}

// Request 1: the "0" key and the link, from a query and from Base, in both conventions.
const TOGGLES = [
  ['desktopFirst', 'tablet', /< 48rem/],
  ['mobileFirst', 'tablet', /≥ 30rem/],
];
const TOGGLE_ACTIONS = [
  ['the 0 key', (panel) => assert.equal(panel.followToggleKey(), true, 'the key toggled')],
  ['the link', (panel) => press(panel, link(panel))],
];

for (const [name, device, query] of TOGGLES) {
  for (const [actionName, act] of TOGGLE_ACTIONS) {
    test(`${name}: following on a query, ${actionName} edits Base with the canvas where it is, and again follows back`, async (context) => {
      const { panel, canvas } = await mount(name, device, deviceWidthPx(device));
      context.after(() => panel.unmount());
      assert.match(label(panel), query, 'following: the canvas query is the target');
      assert.equal(following(panel), true);
      const before = { device: canvas.device, widthPx: canvas.widthPx, pressed: pressedDevice(canvas) };
      const off = await recorded(panel, `${actionName}: off`, () => act(panel));
      assert.equal(label(panel), 'Base', 'the target is Base');
      assert.equal(following(panel), false, 'the link is off');
      assert.equal(canvas.widthPx, before.widthPx, 'the same canvas width');
      assert.equal(canvas.device, before.device, 'the same device');
      assert.equal(pressedDevice(canvas), before.pressed, 'the same device pressed in the toolbar');
      assert.deepEqual(canvas.requests, [], 'the panel asked the canvas for nothing');
      assert.equal(off.length, 2, `straight from the query to Base, no frame between: ${JSON.stringify(off)}`);
      assert.equal(off[1], 'Base | held');
      const on = await recorded(panel, `${actionName}: on`, () => act(panel));
      assert.match(label(panel), query, 'following again: back on the canvas query');
      assert.equal(following(panel), true);
      assert.deepEqual(canvas.requests, [], 'and still nothing asked of the canvas');
      assert.equal(on.length, 2, `straight back, no frame between: ${JSON.stringify(on)}`);
      assert.deepEqual(panel.writes, [], 'toggling writes nothing');
    });
  }
}

test('desktop-first: following on Base, the 0 key only turns following off', async (context) => {
  const { panel, canvas } = await mount('desktopFirst', 'desktop', DESKTOP_WIDTH_PX);
  context.after(() => panel.unmount());
  assert.equal(label(panel), 'Base');
  const frames = await recorded(panel, '0', () => panel.followToggleKey());
  assert.equal(label(panel), 'Base');
  assert.equal(following(panel), false);
  assert.deepEqual(frames, ['Base | following', 'Base | held']);
  assert.deepEqual(canvas.requests, []);
});

// Request 2: a breakpoint row picked from the list, per convention: [the device the canvas starts on, row, its
// canvas width, the device the toolbar then presses, the trigger]. The start is a device another row holds on.
const PICKS = [
  ['desktopFirst', 'tablet', 'Phone', deviceWidthPx('phone'), 'phone', /< 30rem/],
  ['desktopFirst', 'tablet', 'Laptop', deviceWidthPx('laptop'), 'laptop', /< 64rem/],
  // Mobile-first rows are named for the `< X` breakpoints but hold from X up: the query's own boundary width.
  ['mobileFirst', 'laptop', 'Phone', 480, 'tablet', /≥ 30rem/],
  ['mobileFirst', 'laptop', 'Laptop', 1024, 'desktop', /≥ 64rem/],
];

for (const [name, start, row, widthPx, pressed, query] of PICKS) {
  test(`${name}: following on ${start}, clicking ${row} moves the canvas to ${widthPx}px and keeps following`, async (context) => {
    const { panel, canvas } = await mount(name, start, deviceWidthPx(start));
    context.after(() => panel.unmount());
    const before = picture(panel.container);
    await openList(panel);
    const frames = await recorded(panel, `click ${row}`, () => press(panel, option(row)));
    assert.deepEqual(canvas.requests, [widthPx], 'one request, the breakpoint width');
    assert.equal(canvas.widthPx, widthPx, 'the canvas is at that width');
    assert.equal(pressedDevice(canvas), pressed, 'the toolbar presses the device for that width');
    assert.match(label(panel), query, 'the target is the row');
    assert.equal(following(panel), true, 'the link stays on');
    assert.equal(frames[0].startsWith(before.split(' | ')[0]), true, 'the recording starts from the old picture');
    for (const frame of frames.slice(1)) {
      assert.match(frame, query, `no frame snapped back to the old row: ${JSON.stringify(frames)}`);
      assert.match(frame, /\| following$/, `no frame turned the link off: ${JSON.stringify(frames)}`);
    }
    assert.deepEqual(panel.writes, []);
  });
}

for (const name of ['desktopFirst', 'mobileFirst']) {
  test(`${name}: following, clicking the row the canvas is on moves nothing`, async (context) => {
    const { panel, canvas } = await mount(name, 'tablet', deviceWidthPx('tablet'));
    context.after(() => panel.unmount());
    const before = picture(panel.container);
    await openList(panel);
    const current = options().find((candidate) => candidate.getAttribute('aria-selected') === 'true');
    await panel.user('click the checked row', () => press(panel, current));
    assert.equal(picture(panel.container), before, 'the same target, still following');
    assert.deepEqual(canvas.requests, []);
  });

  test(`${name}: following, a row with no canvas width is held and the canvas stays`, async (context) => {
    const { panel, canvas } = await mount(name, 'tablet', deviceWidthPx('tablet'));
    context.after(() => panel.unmount());
    await openList(panel);
    const motion = options().find((candidate) => /prefers-reduced-motion/.test(text(candidate)));
    assert.ok(motion, 'the motion query is listed');
    await panel.user('click the motion row', () => press(panel, motion));
    assert.match(label(panel), /prefers-reduced-motion/, 'the target is the motion query');
    assert.equal(following(panel), false, 'the link turns off: the target is held there');
    assert.deepEqual(canvas.requests, [], 'the canvas did not move');
    assert.equal(canvas.widthPx, deviceWidthPx('tablet'));
  });

  test(`${name}: choosing Phone with the arrow keys and Enter behaves like a click`, async (context) => {
    const { panel, canvas } = await mount(name, 'desktop', DESKTOP_WIDTH_PX);
    context.after(() => panel.unmount());
    await openList(panel);
    const list = () => document.querySelector('.embed-editor_context-select .u-select-list');
    const active = () => list().querySelector('[data-active="true"]');
    for (let step = 0; step < options().length && (active() === null || !text(active()).startsWith('Phone')); step += 1) {
      await panel.user('arrow down', () => key(panel, list(), 'ArrowDown'));
    }
    assert.ok(text(active()).startsWith('Phone'), 'the arrow keys reach Phone');
    await panel.user('Enter', () => key(panel, list(), 'Enter'));
    await panel.settle();
    const widthPx = name === 'desktopFirst' ? deviceWidthPx('phone') : 480;
    assert.deepEqual(canvas.requests, [widthPx]);
    assert.equal(canvas.widthPx, widthPx);
    assert.equal(following(panel), true, 'the link stays on');
  });
}

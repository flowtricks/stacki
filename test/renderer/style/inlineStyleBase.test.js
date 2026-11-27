// Goal: the "Inline styles" target and a media query never go together. A style attribute applies at
// every width, so with it picked the breakpoint dropdown shows Base, however it came to be picked and
// whatever else moves the dropdown while it is:
//   1. the chip clicked on a query goes to Base as picking Base in the dropdown does (following moves
//      the canvas to Base's width; a held target leaves the canvas alone);
//   2. while it is picked, a resized canvas, the "0" key and the link keep the dropdown on Base;
//   3. a query picked in the list, or one added, leaves the attribute, and the next edit lands in a rule,
//      never in the attribute;
//   4. reselecting an element whose attribute was the target, and Design mode's inline default, land on
//      Base too, without moving the canvas.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel with the
// host's inline-style write. The canvas is the small state machine of followCanvasPick.test.js. Every
// recorded frame (DOM mutation and animation frame) is checked for the forbidden pair, the chip
// pressed beside a query on the trigger. Dispatched events only; fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, press } = require('../../helpers/stylePanelHarness.js');

const DESKTOP_WIDTH_PX = 1440;
const TABLET_WIDTH_PX = 767;

const element = (id, className, style) => ({
  id,
  kind: 'element',
  name: 'div',
  props: { class: { type: 'string', value: className }, style: { type: 'string', value: style } },
  children: [],
});
const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/patterns.css',
      css: '.grid { gap: 3rem; @media (width < 48rem) { gap: 1.5rem; } }\n.card { gap: 2rem; @media (width < 48rem) { gap: 1rem; } }\n',
    },
  ],
  nodes: [element('n1', 'grid', 'color: red;'), element('n2', 'card', 'color: blue;')],
  markup: '<div class="grid" data-avb-p="n1">a</div><div class="card" data-avb-p="n2">b</div>',
  selectedId: 'n1',
};

let counter = 0;
async function mount(device, widthPx) {
  const panel = await mountStylePanel(FIXTURE);
  // The CSS code section opens with the chip, and its editor measures against the window's own constructor.
  globalThis.Window = panel.window.Window;
  const canvas = { device, widthPx, requests: [] };
  const inlineWrites = [];
  const report = (nextDevice, nextWidthPx) => {
    canvas.device = nextDevice;
    canvas.widthPx = nextWidthPx;
    setTimeout(() => panel.rerender({ device: canvas.device, canvasWidthPx: canvas.widthPx }), 0);
  };
  counter += 1;
  panel.rerender({
    project: { path: `/fixture-inline-base-${counter}` },
    device,
    canvasWidthPx: widthPx,
    onSetInlineStyle: (nodeId, style) => inlineWrites.push([nodeId, style]),
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
  /** The person resizes the canvas: no request from the panel. */
  const resize = async (nextDevice, nextWidthPx) => {
    await panel.data('resize the canvas', () => report(nextDevice, nextWidthPx));
    await panel.settle();
  };
  return { panel, canvas, inlineWrites, resize };
}

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const label = (panel) => text(trigger(panel));
const link = (panel) => trigger(panel).querySelector('.u-select-pin');
const chip = (panel) => panel.container.querySelector('button.embed-editor_selector-chip.is-inline');
const picked = (panel) => chip(panel)?.getAttribute('aria-pressed') === 'true';
const options = () => [...document.querySelectorAll('.embed-editor_context-select .u-select-list [role="option"]')];

async function step(panel, name, action) {
  await panel.user(name, action);
  await panel.settle();
}

async function pickRow(panel, start) {
  await step(panel, 'open the list', () => press(panel, trigger(panel)));
  const row = options().find((candidate) => text(candidate).startsWith(start));
  assert.ok(row, `the list holds ${start}: ${options().map(text).join(' / ')}`);
  await step(panel, `pick ${start}`, () => press(panel, row));
}

// The forbidden pair in any painted frame: the attribute pressed and a query on the trigger.
function watch(panel) {
  const recorder = recordFrames(panel, (container) => {
    const button = container.querySelector('.embed-editor_context-select .u-select-button');
    const inline = container.querySelector('button.embed-editor_selector-chip.is-inline');
    return `${button === null ? '' : text(button)}|${inline?.getAttribute('aria-pressed') ?? 'none'}`;
  });
  return () => {
    const frames = recorder.stop();
    const bad = frames.filter((frame) => frame.endsWith('|true') && !frame.startsWith('Base|'));
    assert.deepEqual(bad, [], `no frame shows the attribute picked beside a query: ${JSON.stringify(frames)}`);
  };
}

test('following on a query, picking the chip goes to Base as picking Base does: the canvas moves, following stays', async (context) => {
  const { panel, canvas, inlineWrites } = await mount('tablet', TABLET_WIDTH_PX);
  context.after(() => panel.unmount());
  assert.match(label(panel), /< 48rem/);
  const check = watch(panel);
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  assert.equal(picked(panel), true);
  assert.equal(label(panel), 'Base');
  assert.equal(link(panel).getAttribute('aria-pressed'), 'true', 'still following');
  assert.equal(canvas.requests.length, 1, `one canvas request, as the Base row makes: ${JSON.stringify(canvas.requests)}`);
  assert.deepEqual(panel.writes, [], 'picking writes nothing');
  assert.deepEqual(inlineWrites, []);
  check();
});

test('held on a query, picking the chip goes to Base and leaves the canvas where it is', async (context) => {
  const { panel, canvas, resize } = await mount('tablet', TABLET_WIDTH_PX);
  context.after(() => panel.unmount());
  await step(panel, 'hold', () => press(panel, link(panel)));
  await resize('desktop', DESKTOP_WIDTH_PX);
  await pickRow(panel, 'Tablet');
  assert.match(label(panel), /< 48rem/);
  const check = watch(panel);
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  assert.equal(label(panel), 'Base');
  assert.equal(picked(panel), true);
  assert.deepEqual(canvas.requests, []);
  check();
});

test('while the attribute is picked, a resize, the 0 key and the link keep Base; leaving it follows the canvas again', async (context) => {
  const { panel, canvas, resize } = await mount('desktop', DESKTOP_WIDTH_PX);
  context.after(() => panel.unmount());
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  assert.deepEqual(canvas.requests, [], 'already on Base: the canvas is not touched');
  const check = watch(panel);
  await resize('tablet', TABLET_WIDTH_PX);
  assert.equal(label(panel), 'Base', 'following does not move the attribute into a query');
  for (const name of ['0 off', '0 on']) {
    await step(panel, name, () => panel.followToggleKey());
    assert.equal(label(panel), 'Base');
    assert.equal(picked(panel), true);
  }
  for (const name of ['link off', 'link on']) {
    await step(panel, name, () => press(panel, link(panel)));
    assert.equal(label(panel), 'Base');
    assert.equal(picked(panel), true);
  }
  assert.deepEqual(canvas.requests, []);
  assert.deepEqual(panel.writes, []);
  check();
  await step(panel, 'leave the chip', () => press(panel, chip(panel)));
  assert.equal(picked(panel), false);
  assert.match(label(panel), /< 48rem/, 'following takes the canvas row once the attribute is left');
});

for (const start of ['following', 'held']) {
  test(`${start}: a query picked while the attribute is the target leaves it, and nothing is written into the attribute`, async (context) => {
    const { panel, inlineWrites } = await mount('desktop', DESKTOP_WIDTH_PX);
    context.after(() => panel.unmount());
    if (start === 'held') {
      await step(panel, 'hold', () => press(panel, link(panel)));
    }
    await step(panel, 'pick the chip', () => press(panel, chip(panel)));
    const check = watch(panel);
    await pickRow(panel, 'Tablet');
    assert.match(label(panel), /< 48rem/, 'the pick holds');
    assert.equal(picked(panel), false, 'the attribute is left');
    assert.match(text(panel.container.querySelector('.embed-editor_selector-chip.is-active')), /grid/, 'a rule styled in the query is picked');
    assert.deepEqual(inlineWrites, []);
    assert.deepEqual(panel.writes, [], 'picking writes nothing');
    check();
  });
}

test('picking Base while the attribute is the target keeps it, with no rule picked beside it', async (context) => {
  const { panel } = await mount('desktop', DESKTOP_WIDTH_PX);
  context.after(() => panel.unmount());
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  await pickRow(panel, 'Base');
  assert.equal(picked(panel), true);
  assert.equal(panel.container.querySelectorAll('.embed-editor_selector-chip.is-active').length, 1, 'only the attribute chip');
});

test('reselecting an element whose attribute was the target lands on Base without moving the canvas', async (context) => {
  const { panel, canvas, resize } = await mount('desktop', DESKTOP_WIDTH_PX);
  context.after(() => panel.unmount());
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  await step(panel, 'select the other element', () => panel.select('n2'));
  assert.equal(picked(panel), false);
  await resize('tablet', TABLET_WIDTH_PX);
  assert.match(label(panel), /< 48rem/, 'the other element follows the canvas');
  const check = watch(panel);
  await step(panel, 'select the first element again', () => panel.select('n1'));
  assert.equal(picked(panel), true, 'its attribute is the target again');
  assert.equal(label(panel), 'Base');
  assert.deepEqual(canvas.requests, []);
  check();
});

test('Design mode: each selection starts on the attribute and on Base, on a narrow canvas too', async (context) => {
  const { panel, canvas, inlineWrites } = await mount('tablet', TABLET_WIDTH_PX);
  context.after(() => {
    panel.inlineDefault('selector');
    panel.unmount();
  });
  assert.match(label(panel), /< 48rem/);
  panel.inlineDefault('inline');
  const check = watch(panel);
  for (const id of ['n2', 'n1']) {
    await step(panel, `select ${id}`, () => panel.select(id));
    assert.equal(picked(panel), true, `${id} starts on its attribute`);
    assert.equal(label(panel), 'Base');
  }
  assert.deepEqual(canvas.requests, [], 'a selection resizes no canvas');
  check();
  // A query asked for still wins, and stays.
  await pickRow(panel, 'Tablet');
  assert.match(label(panel), /< 48rem/);
  assert.equal(picked(panel), false);
  assert.deepEqual(inlineWrites, []);
});

// In Design mode the canvas's width is the shown frame's own: a pick of the chip that moved it would resize the
// frame. The chip is left and picked again, as a person does after following to a query.
test('Design mode: picking the chip on a narrow canvas goes to Base and never moves the canvas', async (context) => {
  const { panel, canvas } = await mount('tablet', TABLET_WIDTH_PX);
  context.after(() => {
    panel.inlineDefault('selector');
    panel.unmount();
  });
  panel.inlineDefault('inline');
  await step(panel, 'select the other element', () => panel.select('n2'));
  await step(panel, 'leave the chip', () => press(panel, chip(panel)));
  assert.match(label(panel), /< 48rem/, 'following takes the canvas row once the attribute is left');
  const check = watch(panel);
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  assert.equal(picked(panel), true);
  assert.equal(label(panel), 'Base');
  assert.equal(link(panel).getAttribute('aria-pressed'), 'true', 'the follow mode is left as it was');
  for (const name of ['0 off', '0 on']) {
    await step(panel, name, () => panel.followToggleKey());
    assert.equal(label(panel), 'Base');
  }
  await panel.settle();
  assert.equal(label(panel), 'Base', 'it does not flip back');
  assert.deepEqual(canvas.requests, [], 'neither the pick nor what follows it moves the canvas');
  check();
  // Base picked in the dropdown is a pick of a width, here as in the editor.
  await pickRow(panel, 'Base');
  assert.equal(picked(panel), true);
  assert.equal(canvas.requests.length, 1, `the dropdown's Base moves the canvas: ${JSON.stringify(canvas.requests)}`);
});

test('adding a query while the attribute is the target leaves the attribute', async (context) => {
  const { panel, inlineWrites } = await mount('desktop', DESKTOP_WIDTH_PX);
  context.after(() => panel.unmount());
  await step(panel, 'pick the chip', () => press(panel, chip(panel)));
  await step(panel, 'open the list', () => press(panel, trigger(panel)));
  const add = options().find((candidate) => /add/i.test(text(candidate)));
  assert.ok(add, `the list offers a new query: ${options().map(text).join(' / ')}`);
  await step(panel, 'add query', () => press(panel, add));
  const rows = () => [...panel.container.querySelectorAll('.embed-editor_add-query .embed-editor_aq-row')];
  const unwritten = rows().find((row) => !row.classList.contains('is-added'));
  assert.ok(unwritten, 'the form is open with a breakpoint not written yet');
  const check = watch(panel);
  await step(panel, 'add it', () => press(panel, unwritten));
  // Which row the dropdown then shows is Add query's own business (addQueryForm.test.js); here: the query is
  // written to the stylesheet for a rule, with the attribute left alone.
  assert.equal(picked(panel), false, 'the attribute is left');
  assert.match(panel.writes.map((write) => write.css).join('\n'), /width < 64rem/);
  assert.deepEqual(inlineWrites, []);
  check();
});

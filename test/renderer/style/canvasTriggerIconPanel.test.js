// Goal: in the real style panel the breakpoint trigger agrees with the canvas toolbar. A mobile-first
// heading (`.heading { @media (width >= 48rem) { … } }`, the default breakpoints) on the Desktop device
// at 1033px follows `≥ 48rem` and wears the Desktop icon, never Tablet; a desktop-first one reads Base
// there; and switching devices back and forth paints no frame with a device the toolbar is not on.
// Method: the real StylePanel through the shared harness. The toolbar's state arrives as the `device`
// and `canvasWidthPx` props, as the app passes them; the trigger's icon is read by its Central icon
// name (`data-central-icon`). Frames are recorded with the harness's MutationObserver and animation
// frame sampler while the device changes; events are dispatched, nothing is timed, and each test uses
// a unique fake project path so follow state never leaks between tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, directFailure } = require('../../helpers/stylePanelHarness.js');

const MOBILE_FIRST = '.heading { font-size: 2rem; @media (width >= 48rem) { font-size: 3rem; } }';
const DESKTOP_FIRST = '.heading { font-size: 3rem; @media (width < 48rem) { font-size: 2rem; } }';
const node = { id: 'n1', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'heading' } }, children: [] };
const fixture = (css) => ({
  sheets: [{ rel: 'src/styles/typography.css', css }],
  nodes: [node],
  markup: '<h2 class="heading" data-avb-p="n1">Title</h2>',
  selectedId: 'n1',
});

let counter = 0;
async function mount(css, canvas) {
  const panel = await mountStylePanel(fixture(css));
  counter += 1;
  panel.rerender({ project: { path: `/fixture-canvas-trigger-${counter}` }, ...canvas, onCanvasWidth: () => {}, onDesktopCanvas: () => {} });
  await panel.settle();
  return panel;
}

const trigger = (container) => container.querySelector('.embed-editor_context-select .u-select-button');
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const iconName = (container) => trigger(container)?.querySelector('.u-select-icon svg')?.getAttribute('data-central-icon') ?? 'none';
const picture = (container) => (trigger(container) === null ? 'no trigger' : `${iconName(container)} ${text(trigger(container))}`);
const moveCanvas = (panel, canvas) => panel.data(`${canvas.device} ${canvas.canvasWidthPx}px`, () => panel.rerender(canvas));

const DESKTOP = { device: 'desktop', canvasWidthPx: 1033 };
const LAPTOP_WIDTH = { device: 'custom', canvasWidthPx: 900 };
const PHONE_WIDTH = { device: 'custom', canvasWidthPx: 390 };

test('mobile-first at the Desktop device: the trigger follows ≥ 48rem and wears the Desktop icon', async (context) => {
  const panel = await mount(MOBILE_FIRST, DESKTOP);
  context.after(() => panel.unmount());
  assert.match(text(trigger(panel.container)), /≥ 48rem/, 'the query that holds at 1033px is the target');
  assert.equal(iconName(panel.container), 'studioDisplay', 'the Desktop icon, as the toolbar shows');
  assert.notEqual(iconName(panel.container), 'tablet', 'never the Tablet icon');
});

test('mobile-first at a dragged laptop width wears the Laptop icon, and Base at a phone width', async (context) => {
  const panel = await mount(MOBILE_FIRST, LAPTOP_WIDTH);
  context.after(() => panel.unmount());
  assert.equal(iconName(panel.container), 'macbookAir', '900px is the Laptop device');
  await moveCanvas(panel, PHONE_WIDTH);
  assert.equal(text(trigger(panel.container)), 'Base', 'mobile-first Base is the smallest layout');
});

test('desktop-first at the Desktop device reads Base', async (context) => {
  const panel = await mount(DESKTOP_FIRST, DESKTOP);
  context.after(() => panel.unmount());
  assert.equal(text(trigger(panel.container)), 'Base', 'Desktop is Base');
  assert.notEqual(iconName(panel.container), 'tablet', 'no device icon of a narrower breakpoint');
});

test('held on ≥ 48rem, the icon still tracks the device the edit shows on', async (context) => {
  const panel = await mount(MOBILE_FIRST, DESKTOP);
  context.after(() => panel.unmount());
  const pin = trigger(panel.container).querySelector('.u-select-pin');
  assert.ok(pin, 'the follow toggle is drawn');
  pin.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  await moveCanvas(panel, PHONE_WIDTH);
  assert.match(text(trigger(panel.container)), /≥ 48rem/, 'held through the resize');
  assert.equal(iconName(panel.container), 'tablet', 'outside the canvas the row keeps its own icon');
  await moveCanvas(panel, DESKTOP);
  assert.equal(iconName(panel.container), 'studioDisplay', 'back inside, the Desktop icon');
});

test('switching devices paints no frame with a device the toolbar is not on', async (context) => {
  const panel = await mount(MOBILE_FIRST, LAPTOP_WIDTH);
  context.after(() => panel.unmount());
  for (const [canvas, final] of [
    [DESKTOP, 'studioDisplay .heading·≥ 48rem'],
    [LAPTOP_WIDTH, 'macbookAir .heading·≥ 48rem'],
    [DESKTOP, 'studioDisplay .heading·≥ 48rem'],
  ]) {
    const recorder = recordFrames(panel, picture);
    await moveCanvas(panel, canvas);
    const frames = recorder.stop();
    assert.equal(frames[frames.length - 1], final, `${canvas.device} ${canvas.canvasWidthPx}px: the settled trigger`);
    const failure = directFailure(frames.slice(1), () => false);
    assert.equal(failure, undefined, `${canvas.device}: the trigger went straight to its final picture (${JSON.stringify(frames)})`);
    for (const frame of frames) {
      assert.doesNotMatch(frame, /^tablet/, `no frame wore the Tablet icon: ${frame}`);
    }
  }
});

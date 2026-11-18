// Goal: in a desktop-first component the following panel shows the breakpoint that holds at the canvas
// width as the active, empty target (`< 48rem`, not Base) with nothing written, the first style written
// there creates the matching `@media (width < 48rem)` block after the existing rules in one write, a
// held panel is unchanged, and a mobile-first component keeps Base at the smallest width.
// Method: the real StylePanel through the shared harness over one stylesheet with a `.grid` rule and no
// queries (so the project's default breakpoints, narrower than Desktop, decide). Widths arrive as the
// `canvasWidthPx` prop; the first style is typed into the Gap field. Writes are the harness's recorded
// stylesheet writes; events are dispatched, nothing is timed, and the project path is fake and unique per test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');

const GRID = '.grid { display: grid; gap: 1rem; }';
const node = { id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] };
const fixture = (css) => ({
  sheets: [{ rel: 'src/styles/patterns.css', css }],
  nodes: [node],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
});

let counter = 0;
async function mount(css, widthPx) {
  const panel = await mountStylePanel(fixture(css));
  counter += 1;
  panel.rerender({ project: { path: `/fixture-follow-breakpoint-${counter}` }, canvasWidthPx: widthPx, onCanvasWidth: () => {}, onDesktopCanvas: () => {} });
  await panel.settle();
  return panel;
}

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const shown = (panel) => text(trigger(panel));
const pin = (panel) => trigger(panel).querySelector('.u-select-pin');
const resizeTo = (panel, widthPx) => panel.data(`canvas ${widthPx}px`, () => panel.rerender({ canvasWidthPx: widthPx }));

test('following shows the canvas breakpoint as the empty target and writes nothing', async (context) => {
  const panel = await mount(GRID, 700);
  context.after(() => panel.unmount());
  assert.match(shown(panel), /< 48rem/, 'Tablet: the target, not Base');
  await resizeTo(panel, 1000);
  assert.match(shown(panel), /< 64rem/, 'Laptop');
  await resizeTo(panel, 400);
  assert.match(shown(panel), /< 30rem/, 'Phone');
  await resizeTo(panel, 1440);
  assert.equal(shown(panel), 'Base', 'Desktop is Base');
  await resizeTo(panel, 700);
  assert.match(shown(panel), /< 48rem/);
  assert.deepEqual(panel.writes, [], 'selecting and resizing write nothing');
});

test('held at Base, the canvas breakpoint is ignored', async (context) => {
  const panel = await mount(GRID, 1440);
  context.after(() => panel.unmount());
  assert.equal(shown(panel), 'Base');
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  for (const width of [700, 400, 1000]) {
    await resizeTo(panel, width);
    assert.equal(shown(panel), 'Base', `held through ${width}px`);
  }
  assert.deepEqual(panel.writes, []);
});

test('a mobile-first component keeps Base at the smallest width', async (context) => {
  const panel = await mount('.grid { gap: 1rem; @media (width >= 48rem) { gap: 2rem; } }', 400);
  context.after(() => panel.unmount());
  assert.equal(shown(panel), 'Base');
  await resizeTo(panel, 1000);
  assert.match(shown(panel), /≥ 48rem/);
  assert.deepEqual(panel.writes, []);
});

test('the first style written at that breakpoint creates the media block after the existing rules, once', async (context) => {
  const panel = await mount(GRID, 700);
  context.after(() => panel.unmount());
  assert.match(shown(panel), /< 48rem/);
  const input = [...panel.container.querySelectorAll('input')].find((candidate) => /gap/i.test(candidate.closest('.embed-editor_size-row')?.textContent ?? ''));
  assert.ok(input, 'the Gap field is drawn');
  input.focus();
  Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set.call(input, '2rem');
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new panel.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await panel.settle();
  assert.equal(panel.writes.length, 1, 'one write, so one undoable edit');
  const css = panel.writes[0].css;
  assert.ok(css.startsWith(GRID), 'the existing rule is untouched and first');
  assert.equal((css.match(/@media \(width < 48rem\)/g) ?? []).length, 1, 'one new block');
  // The new block starts and closes lines of its own, even after a one-line rule: copied from
  // that rule, it was once written `.grid { … }@media (width < 48rem) {.grid { … } }`.
  assert.equal(
    css,
    `${GRID}\n@media (width < 48rem) {\n\t.grid {\n\t\trow-gap: 2rem;\n\t\tcolumn-gap: 2rem;\n\t}\n}`,
    'the exact bytes the panel writes for a new query block',
  );
  assert.match(shown(panel), /< 48rem/, 'the target is still the breakpoint');
  const again = [...panel.container.querySelectorAll('input')].find((candidate) => /gap/i.test(candidate.closest('.embed-editor_size-row')?.textContent ?? ''));
  again.focus();
  Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set.call(again, '3rem');
  again.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  again.dispatchEvent(new panel.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await panel.settle();
  const second = panel.writes.at(-1).css;
  assert.equal((second.match(/@media/g) ?? []).length, 1, 'the next style goes into the existing block, not a second one');
  assert.match(second, /3rem/);
});

test('held, choosing Base changes only the target and never the canvas; following again retargets', async (context) => {
  const panel = await mount(GRID, 479);
  const canvasRequests = [];
  panel.rerender({ onCanvasWidth: (width) => canvasRequests.push(width), onDesktopCanvas: () => canvasRequests.push('desktop') });
  await panel.settle();
  context.after(() => panel.unmount());
  assert.match(shown(panel), /< 30rem/, 'following at Phone');
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  assert.equal(pin(panel).getAttribute('aria-pressed'), 'false', 'toggled off');
  assert.deepEqual(canvasRequests, [], 'toggling follow never moves the canvas');
  await panel.user('open the list', () => press(panel, trigger(panel)));
  const base = [...document.querySelectorAll('.embed-editor_context-select [role="option"]')].find((option) => text(option).startsWith('Base'));
  await panel.user('choose Base', () => press(panel, base));
  assert.equal(shown(panel), 'Base', 'the target is Base');
  assert.deepEqual(canvasRequests, [], 'choosing Base while held leaves the canvas where it is');
  pin(panel).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }));
  await panel.settle();
  assert.match(shown(panel), /< 30rem/, 'following again retargets to the canvas width');
  assert.deepEqual(canvasRequests, [], 'and still never moves the canvas');
});

test('while following, choosing Base moves the canvas to where Base is the layer in effect, as Phone and Tablet picks move it', async (context) => {
  const panel = await mount(GRID, 479);
  const canvasRequests = [];
  panel.rerender({ onCanvasWidth: (width) => canvasRequests.push(width), onDesktopCanvas: () => canvasRequests.push('desktop') });
  await panel.settle();
  context.after(() => panel.unmount());
  await panel.user('open the list', () => press(panel, trigger(panel)));
  const base = [...document.querySelectorAll('.embed-editor_context-select [role="option"]')].find((option) => text(option).startsWith('Base'));
  await panel.user('choose Base', () => press(panel, base));
  assert.equal(shown(panel), 'Base');
  assert.ok(canvasRequests.length >= 1, 'a pick while following moves the canvas, then holds');
});

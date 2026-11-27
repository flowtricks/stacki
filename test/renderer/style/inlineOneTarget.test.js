// Goal: the Style panel has one edit target. While the "Inline styles" chip is it, no class chip looks
// selected beside it and an edit writes the style attribute; while a rule is it, the chip is not selected
// and an edit writes that rule. The element's classes reach the panel after its selection does, and the
// default class pick they trigger once selected a class chip next to the attribute (`.grid` and "Inline
// styles" both pressed, the edit going to the attribute): in Design mode on a new selection, and in the
// editor on a reselection or when the picked element's classes change.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel with the
// host's inline-style write. Every recorded frame (DOM mutation and animation frame) is checked for two
// pressed chips, and the canvas's answers are also held and released late, in reverse. Where an edit
// lands is read from the writes the host got: the attribute's, or the stylesheet's. Dispatched events
// only; fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, press } = require('../../helpers/stylePanelHarness.js');

const element = (id, className, style) => ({
  id,
  kind: 'element',
  name: 'div',
  props: { class: { type: 'string', value: className }, ...(style === undefined ? {} : { style: { type: 'string', value: style } }) },
  children: [],
});
const FIXTURE = {
  sheets: [{ rel: 'src/styles/patterns.css', css: '.grid { gap: 3rem; }\n.card { gap: 2rem; }\n.wide { gap: 4rem; }\n' }],
  nodes: [element('n1', 'grid', 'color: red;'), element('n2', 'card')],
  markup: '<div class="grid" data-avb-p="n1">a</div><div class="card" data-avb-p="n2">b</div>',
  selectedId: 'n1',
};

let counter = 0;
async function mount(context, inlineDefault) {
  const panel = await mountStylePanel(FIXTURE);
  globalThis.Window = panel.window.Window;
  const inlineWrites = [];
  context.after(() => {
    panel.inlineDefault('selector');
    panel.unmount();
  });
  panel.inlineDefault(inlineDefault);
  counter += 1;
  panel.rerender({
    project: { path: `/fixture-inline-one-${counter}` },
    onSetInlineStyle: (nodeId, style) => inlineWrites.push([nodeId, style]),
  });
  await panel.settle();
  return { panel, inlineWrites };
}

const inlineChip = (panel) => panel.container.querySelector('button.embed-editor_selector-chip.is-inline');
const classChip = (panel, selector) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip:not(.is-inline)')].find((chip) => chip.textContent.trim() === selector);
const pressedOf = (container) =>
  [...container.querySelectorAll('button.embed-editor_selector-chip[aria-pressed="true"]')].map((chip) => chip.textContent.trim());
const pressed = (panel) => pressedOf(panel.container);

async function step(panel, name, action) {
  await panel.user(name, action);
  await panel.settle();
}

// No painted frame ever shows two selected targets.
function watch(panel) {
  const recorder = recordFrames(panel, (container) => JSON.stringify(pressedOf(container)));
  return () => {
    const frames = recorder.stop();
    const doubled = frames.filter((frame) => JSON.parse(frame).length > 1);
    assert.deepEqual(doubled, [], `no frame shows two selected chips: ${JSON.stringify(frames)}`);
  };
}

async function chooseFlex(panel) {
  const button = [...panel.container.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === 'Flex');
  assert.ok(button, 'the Display row offers Flex');
  await step(panel, 'choose Flex', () => press(panel, button));
}

const stylesheetText = (writes) => writes.map((write) => write.css).join('\n');

test('Design mode: a new selection shows only Inline styles once its classes arrive, and the edit goes inline', async (context) => {
  const { panel, inlineWrites } = await mount(context, 'inline');
  const check = watch(panel);
  for (const id of ['n2', 'n1', 'n2']) {
    await step(panel, `select ${id}`, () => panel.select(id));
    assert.deepEqual(pressed(panel), ['Inline styles'], id);
  }
  check();
  await chooseFlex(panel);
  assert.deepEqual(inlineWrites, [['n2', { type: 'string', value: 'display: flex' }]]);
  assert.deepEqual(panel.writes, [], 'no stylesheet is written');
});

test('Design mode: answers that land late and out of order never select a class beside the attribute', async (context) => {
  const { panel } = await mount(context, 'inline');
  const check = watch(panel);
  panel.bridge.mode = 'held';
  await step(panel, 'select n2', () => panel.select('n2'));
  await step(panel, 'select n1 before n2 answered', () => panel.select('n1'));
  for (let round = 0; round < 20 && panel.bridge.held > 0; round += 1) {
    await panel.data(`release round ${round}`, () => panel.bridge.release({ order: 'reverse' }));
    await panel.settle();
  }
  panel.bridge.mode = 'immediate';
  assert.deepEqual(pressed(panel), ['Inline styles']);
  check();
});

test('a class the picked element gains selects nothing beside the attribute, in Design mode and the editor', async (context) => {
  for (const mode of ['inline', 'selector']) {
    await context.test(mode, async (inner) => {
      const { panel } = await mount(inner, mode);
      if (mode === 'selector') {
        await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
      }
      assert.deepEqual(pressed(panel), ['Inline styles']);
      const check = watch(panel);
      await panel.data('the page adds a class', () => panel.setPageClasses('n1', ['grid', 'wide']));
      await panel.settle();
      assert.deepEqual(pressed(panel), ['Inline styles']);
      check();
    });
  }
});

test('editor: reselecting an element whose attribute was the target shows only that chip', async (context) => {
  const { panel, inlineWrites } = await mount(context, 'selector');
  await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
  await step(panel, 'select n2', () => panel.select('n2'));
  assert.deepEqual(pressed(panel), ['.card'], 'the other element starts on its class, as ever');
  const check = watch(panel);
  await step(panel, 'select n1 again', () => panel.select('n1'));
  assert.deepEqual(pressed(panel), ['Inline styles']);
  check();
  await chooseFlex(panel);
  assert.deepEqual(inlineWrites, [['n1', { type: 'string', value: 'color: red; display: flex;' }]]);
  assert.deepEqual(panel.writes, []);
});

test('Design mode: toggling between the chips keeps one target, and each edit lands in it', async (context) => {
  const { panel, inlineWrites } = await mount(context, 'inline');
  await step(panel, 'select n2', () => panel.select('n2'));
  const check = watch(panel);
  await step(panel, 'pick the class', () => press(panel, classChip(panel, '.card')));
  assert.deepEqual(pressed(panel), ['.card']);
  await step(panel, 'pick the attribute', () => press(panel, inlineChip(panel)));
  assert.deepEqual(pressed(panel), ['Inline styles']);
  await step(panel, 'leave the attribute', () => press(panel, inlineChip(panel)));
  assert.deepEqual(pressed(panel), [], 'leaving selects nothing, as ever');
  await panel.data('the page adds a class', () => panel.setPageClasses('n2', ['card', 'wide']));
  await panel.settle();
  assert.equal(inlineChip(panel).getAttribute('aria-pressed'), 'false', 'a left attribute is not taken back');
  // The element's own default may have selected its class already; a click on a selected chip would leave it.
  if (classChip(panel, '.card').getAttribute('aria-pressed') !== 'true') {
    await step(panel, 'pick the class again', () => press(panel, classChip(panel, '.card')));
  }
  assert.deepEqual(pressed(panel), ['.card']);
  check();
  await chooseFlex(panel);
  assert.deepEqual(inlineWrites, [], 'with a class picked nothing is written inline');
  assert.match(stylesheetText(panel.writes), /\.card\s*\{[^}]*display:\s*flex/);
});

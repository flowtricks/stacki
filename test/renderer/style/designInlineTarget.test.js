// Goal: in Design mode "Inline styles" is the selected chip on every selection, and an edit made on it changes
// the selected element only. It never moves to a class by itself, and never writes a component's file, which
// every instance shares. Where this instance can take a style of its own (a plain element; an instance that
// renders no style, as a Lumos Grid with default columns) the controls are live and the edit is written to
// that node's `style`. Where the component writes the style the element renders there is no such place: a Grid
// with columns set writes `style={columns} {...rest}`, so a `style` on the instance is a second attribute the
// browser ignores, and a Heading with maxWidth writes it by a conditional in Heading.astro, shared by every
// Heading. There the chip stays selected, the controls are disabled and say why on hover, and nothing is
// written. Picking a class is the person's own step, which brings the controls back for a global edit.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel with the host's
// inline-style write, and the fixture project's own Grid.astro and Heading.astro as the instances' component
// files. Selections are made with the canvas answering at once, and held then released in reverse, so the
// rendered style and the classes land in either order. What was written is read from the writes the host got
// (the instance's attribute) and the files written (stylesheets and components). Dispatched events only;
// fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');
const { repoPath } = require('../../helpers/sources.js');

const fixtureSource = (rel) => fs.readFileSync(repoPath(`test/fixtures/lumos/components/${rel}`), 'utf8');
const COMPONENTS = new Map([
  ['/fixture/src/components/Grid.astro', fixtureSource('wrapper/Grid.astro')],
  ['/fixture/src/components/Heading.astro', fixtureSource('typography/Heading.astro')],
]);
const COMPONENT_OF = new Map([
  ['grid-set', '/fixture/src/components/Grid.astro'],
  ['grid-default', '/fixture/src/components/Grid.astro'],
  ['heading', '/fixture/src/components/Heading.astro'],
]);
const RELEASE_ROUNDS_MAX = 20;

const text = (value) => ({ type: 'string', value });
const instance = (id, name, props = {}) => ({ id, kind: 'component', name, props, children: [] });
const FIXTURE = {
  sheets: [{ rel: 'src/styles/global.css', css: '.card { gap: 2rem; }\n.grid { gap: 3rem; }\n.heading { gap: 1rem; }\n.list { gap: 4rem; }\n' }],
  nodes: [
    { id: 'plain', kind: 'element', name: 'div', props: { class: text('card') }, children: [] },
    instance('grid-set', 'Grid', { large: { type: 'expr', value: '3' } }),
    instance('grid-default', 'Grid'),
    instance('heading', 'Heading', { maxWidth: { type: 'expr', value: '30' } }),
    { id: 'coded', kind: 'element', name: 'div', props: { class: text('list'), style: { type: 'expr', value: 'styles' } }, children: [] },
  ],
  markup:
    '<div class="card" data-avb-p="plain">a</div><div class="grid" style="--_cols-lg: 3" data-avb-p="grid-set">b</div>' +
    '<div class="grid" data-avb-p="grid-default">c</div><h2 class="heading" style="--_mw: 30ch;" data-avb-p="heading">d</h2>' +
    '<div class="list" style="color: red" data-avb-p="coded">e</div>',
  selectedId: 'plain',
};

let counter = 0;
async function mount(context, mode = 'inline') {
  const panel = await mountStylePanel(FIXTURE);
  // The CSS code section opens with the chip, and its editor measures against the window's own constructor.
  globalThis.Window = panel.window.Window;
  context.after(() => {
    panel.inlineDefault('selector');
    panel.unmount();
  });
  const readSheet = panel.window.avb.readStyleFile;
  panel.window.avb.readStyleFile = async (payload) => {
    const asked = typeof payload === 'string' ? payload : (payload?.path ?? payload?.filePath ?? '');
    return COMPONENTS.has(asked) ? { css: COMPONENTS.get(asked) } : readSheet(payload);
  };
  panel.inlineDefault(mode);
  const inlineWrites = [];
  counter += 1;
  panel.rerender({ project: { path: `/fixture-design-target-${counter}` }, onSetInlineStyle: (...write) => inlineWrites.push(write) });
  await panel.settle();
  return { panel, inlineWrites };
}

async function step(panel, name, action) {
  await panel.user(name, action);
  await panel.settle();
}

// Selecting as Desktop does: an instance's component file is named with the selection.
function select(panel, id) {
  panel.select(id);
  panel.rerender({ selectedComponentPath: COMPONENT_OF.get(id) });
}

const controls = (panel) => panel.container.querySelector('fieldset.embed-editor_controls');
const inlineChip = (panel) => panel.container.querySelector('button.embed-editor_selector-chip.is-inline');
const classChip = (panel, selector) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip:not(.is-inline)')].find((chip) => chip.textContent.trim() === selector);
const pressed = (panel) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip[aria-pressed="true"]')].map((chip) => chip.textContent.trim());
const flexButton = (panel) => [...panel.container.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === 'Flex');

async function chooseFlex(panel) {
  const button = flexButton(panel);
  assert.ok(button, 'the Display row offers Flex');
  await step(panel, 'choose Flex', () => press(panel, button));
}

for (const [id, label] of [
  ['plain', 'a plain element'],
  ['grid-default', 'a Grid instance that renders no style of its own'],
]) {
  test(`Design mode: ${label} starts on Inline styles, live, and an edit writes that node only`, async (context) => {
    const { panel, inlineWrites } = await mount(context);
    await step(panel, 'select another', () => select(panel, 'coded'));
    await step(panel, 'select it', () => select(panel, id));
    assert.deepEqual(pressed(panel), ['Inline styles']);
    assert.equal(controls(panel).matches(':disabled'), false);
    await chooseFlex(panel);
    assert.deepEqual(inlineWrites, [[id, { type: 'string', value: 'display: flex' }]]);
    assert.deepEqual(panel.writes, [], 'no stylesheet and no component file is written');
  });
}

for (const [id, label, why] of [
  ['grid-set', 'a Grid whose component writes style={columns}', /^Grid\.astro writes this element’s style/],
  ['heading', 'a Heading whose component writes a conditional style', /^Heading\.astro writes this element’s style/],
  ['coded', 'an element whose own style is code', /chain of conditions/],
]) {
  test(`Design mode: ${label} keeps Inline styles, locked with why, and nothing is written`, async (context) => {
    const { panel, inlineWrites } = await mount(context);
    for (const round of ['select', 'reselect']) {
      await step(panel, `${round}: leave`, () => select(panel, 'plain'));
      await step(panel, round, () => select(panel, id));
      assert.deepEqual(pressed(panel), ['Inline styles'], round);
      assert.equal(controls(panel).disabled, true, round);
      assert.match(controls(panel).title, why, 'hovering the controls says why');
    }
    await step(panel, 'press a locked control', () => flexButton(panel)?.click());
    assert.deepEqual(inlineWrites, []);
    assert.deepEqual(panel.writes, [], 'no stylesheet and no component file is written');
  });
}

test('Design mode: the person picking the class is what makes a locked Grid editable, in that rule', async (context) => {
  const { panel, inlineWrites } = await mount(context);
  await step(panel, 'select the Grid', () => select(panel, 'grid-set'));
  assert.match(inlineChip(panel).title, /^Grid\.astro writes/, 'the chip says why too');
  await step(panel, 'pick the class', () => press(panel, classChip(panel, '.grid')));
  assert.deepEqual(pressed(panel), ['.grid']);
  assert.equal(controls(panel).disabled, false);
  assert.equal(controls(panel).title, '');
  await chooseFlex(panel);
  assert.match(panel.writes.map((write) => write.css).join('\n'), /display: flex/);
  assert.deepEqual(inlineWrites, []);
});

for (const id of ['grid-set', 'grid-default', 'heading', 'plain']) {
  test(`Design mode: ${id} ends on Inline styles when the canvas answers late and out of order`, async (context) => {
    const { panel } = await mount(context);
    await step(panel, 'select another', () => select(panel, 'coded'));
    panel.bridge.mode = 'held';
    await step(panel, 'select it', () => select(panel, id));
    for (let round = 0; round < RELEASE_ROUNDS_MAX && panel.bridge.held > 0; round += 1) {
      await panel.data(`release round ${round}`, () => panel.bridge.release({ order: 'reverse' }));
      await panel.settle();
    }
    panel.bridge.mode = 'immediate';
    assert.deepEqual(pressed(panel), ['Inline styles']);
    assert.equal(controls(panel).disabled, id === 'grid-set' || id === 'heading');
  });
}

test('editor: the chip picked on a Heading is still editable, as its own pick of the component’s style', async (context) => {
  const { panel } = await mount(context, 'selector');
  await step(panel, 'select the Heading', () => select(panel, 'heading'));
  assert.deepEqual(pressed(panel), ['.heading']);
  await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
  assert.equal(controls(panel).disabled, false);
  assert.doesNotMatch(inlineChip(panel).title, /writes this element/);
});

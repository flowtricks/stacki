// Goal: the Style panel never starts out greyed out. A Lumos Grid instance with columns set renders
// `style="--_cols-lg: 3"`, written by its component as `style={columns}`: code the panel can only show, so
// with that attribute as the target every control is disabled. Design mode starts each selection on "Inline
// styles", which opened such a Grid with the whole panel disabled and nothing saying why. The default must
// land on the element's selector instead, with the controls live and an edit written to that rule; the
// person's own click on the chip still shows the code, read-only, and leaving it brings the controls back.
// The same holds for an element whose own attribute is unreadable code, and an attribute the panel can edit
// stays Design mode's default.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel, with the
// fixture project's own Grid.astro as the instance's component file. Selections are made with the canvas
// answering at once, and held then released in reverse, so the rendered style and the classes land in
// either order. The controls are judged by the fieldset that holds them. Dispatched events only; fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');
const { repoPath } = require('../../helpers/sources.js');

const GRID_PATH = '/fixture/src/components/Grid.astro';
const GRID_SOURCE = fs.readFileSync(repoPath('test/fixtures/lumos/components/wrapper/Grid.astro'), 'utf8');
const RELEASE_ROUNDS_MAX = 20;

const text = (value) => ({ type: 'string', value });
const FIXTURE = {
  sheets: [{ rel: 'src/styles/global.css', css: '.card { gap: 2rem; }\n.grid { gap: 3rem; }\n.list { gap: 4rem; }\n' }],
  nodes: [
    { id: 'n1', kind: 'element', name: 'div', props: { class: text('card') }, children: [] },
    { id: 'n2', kind: 'component', name: 'Grid', props: { large: { type: 'expr', value: '3' } }, children: [] },
    { id: 'n3', kind: 'element', name: 'div', props: { class: text('list'), style: { type: 'expr', value: 'styles' } }, children: [] },
  ],
  markup:
    '<div class="card" data-avb-p="n1">a</div><div class="grid" style="--_cols-lg: 3" data-avb-p="n2">b</div>' +
    '<div class="list" style="color: red" data-avb-p="n3">c</div>',
  selectedId: 'n1',
};

let counter = 0;
async function mount(context) {
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
    return asked === GRID_PATH ? { css: GRID_SOURCE } : readSheet(payload);
  };
  panel.inlineDefault('inline');
  const inlineWrites = [];
  counter += 1;
  panel.rerender({ project: { path: `/fixture-read-only-default-${counter}` }, onSetInlineStyle: (...write) => inlineWrites.push(write) });
  await panel.settle();
  return { panel, inlineWrites };
}

async function step(panel, name, action) {
  await panel.user(name, action);
  await panel.settle();
}

// Selecting as Desktop does: the instance's component file is named with the selection.
function select(panel, id) {
  panel.select(id);
  panel.rerender({ selectedComponentPath: id === 'n2' ? GRID_PATH : undefined });
}

const controls = (panel) => panel.container.querySelector('fieldset.embed-editor_controls');
const inlineChip = (panel) => panel.container.querySelector('button.embed-editor_selector-chip.is-inline');
const pressed = (panel) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip[aria-pressed="true"]')].map((chip) => chip.textContent.trim());

async function chooseFlex(panel) {
  const button = [...panel.container.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === 'Flex');
  assert.ok(button, 'the Display row offers Flex');
  await step(panel, 'choose Flex', () => press(panel, button));
}

for (const [id, selector, label] of [
  ['n2', '.grid', 'a Grid instance whose component writes style={columns}'],
  ['n3', '.list', 'an element whose own style is code'],
]) {
  test(`Design mode: ${label} starts on its selector with the controls live`, async (context) => {
    const { panel, inlineWrites } = await mount(context);
    await step(panel, 'select it', () => select(panel, id));
    assert.deepEqual(pressed(panel), [selector]);
    assert.equal(controls(panel).disabled, false, 'the panel is not greyed out');
    await chooseFlex(panel);
    assert.match(panel.writes.map((write) => write.css).join('\n'), /display: flex/, 'the edit lands in the rule');
    assert.deepEqual(inlineWrites, [], 'the code attribute is not written');
  });
}

test('Design mode: answers that land late and out of order still leave a selector picked and the controls live', async (context) => {
  const { panel } = await mount(context);
  panel.bridge.mode = 'held';
  await step(panel, 'select the Grid', () => select(panel, 'n2'));
  for (let round = 0; round < RELEASE_ROUNDS_MAX && panel.bridge.held > 0; round += 1) {
    await panel.data(`release round ${round}`, () => panel.bridge.release({ order: 'reverse' }));
    await panel.settle();
  }
  panel.bridge.mode = 'immediate';
  assert.deepEqual(pressed(panel), ['.grid']);
  assert.equal(controls(panel).disabled, false);
});

test('Design mode: the chip clicked shows the code read-only; leaving it or reselecting brings the controls back', async (context) => {
  const { panel } = await mount(context);
  await step(panel, 'select the Grid', () => select(panel, 'n2'));
  await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
  assert.deepEqual(pressed(panel), ['Inline styles']);
  assert.equal(controls(panel).disabled, true, 'code takes no edit');
  await step(panel, 'select another element', () => select(panel, 'n1'));
  assert.equal(controls(panel).disabled, false);
  assert.deepEqual(pressed(panel), ['Inline styles'], 'an editable target is still the default');
  await step(panel, 'select the Grid again', () => select(panel, 'n2'));
  assert.deepEqual(pressed(panel), ['.grid']);
  assert.equal(controls(panel).disabled, false);
});

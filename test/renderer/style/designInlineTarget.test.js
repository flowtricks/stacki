// Goal: in Design mode "Inline styles" is the selected chip on every selection, and an edit made on it changes
// the selected element only. It never moves to a class by itself, and never writes a component's file, which
// every instance shares. A plain element takes the edit on its own `style`, and so does an instance whose
// component keeps it: one that combines the instance's style with its own, the instance's last (the fixture
// project's Grid and Heading). The instance's existing style is read back and edited, and removing its last
// declaration removes the attribute. The chip is locked, with why on hover and nothing written, only where the
// edit is shown to be lost now: the component's own value renders for this instance (Grid and Heading as they
// were, `style={columns} {...rest}`, with columns or maxWidth set), or the component drops the style. Where it
// is not shown, nothing is locked that was editable before: the old Grid with default columns, the old Heading
// without maxWidth, Button, and a component that cannot be read are edited as any element. Picking a class is
// the person's own step, which brings the controls back for a global edit. In the editor, the chip picked on a
// combining instance edits the instance, not the component's file.
// Method: the shared harness (test/helpers/stylePanelHarness.js) mounts the real StylePanel with the host's
// inline-style write, which the test feeds back into the page model as the app does. Component files are the
// fixture project's own, and Grid and Heading with the combining edit undone. Selections are made with the canvas
// answering at once, and held then released in reverse, so the rendered style and the classes land in either
// order. What was written is read from the writes the host got (the instance's attribute) and the files written
// (stylesheets and components). Dispatched events only; fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');
const { repoPath } = require('../../helpers/sources.js');

const fixtureSource = (rel) => fs.readFileSync(repoPath(`test/fixtures/lumos/components/${rel}`), 'utf8');
const GRID = fixtureSource('wrapper/Grid.astro');
const HEADING = fixtureSource('typography/Heading.astro');
// The two as they were before they combined the styles.
function uncombined(source, own) {
  const before = source.replace(/style=\{\[.*?, style\]\.filter\(Boolean\)\.join\("; "\) \|\| undefined\}/, own).replace(/\n +style,(?=\n +\.\.\.rest)/, '');
  assert.notEqual(before, source);
  return before;
}
const component = (name) => `/fixture/src/components/${name}.astro`;
const COMPONENTS = new Map([
  [component('Grid'), GRID],
  [component('Heading'), HEADING],
  [component('OldGrid'), uncombined(GRID, 'style={columns}')],
  [component('OldHeading'), uncombined(HEADING, 'style={maxWidth ? `--_mw: ${maxWidth}ch;` : undefined}')],
  [component('Box'), '---\nconst { ...rest } = Astro.props;\n---\n<div {...rest}><slot /></div>\n'],
  [component('Sealed'), '---\nconst { title } = Astro.props;\n---\n<div>{title}</div>\n'],
  [component('Button'), fixtureSource('Button.astro')],
]);
// Each instance node, the component it is of, and what that component renders as the element's style.
const INSTANCES = [
  ['grid-set', 'Grid', '--_cols-lg: 3'],
  ['grid-own', 'Grid', '--_cols-lg: 3; gap: 1rem'],
  ['grid-default', 'Grid', undefined],
  ['heading', 'Heading', '--_mw: 30ch'],
  ['box', 'Box', undefined],
  ['old-grid', 'OldGrid', '--_cols-lg: 3'],
  ['old-grid-default', 'OldGrid', undefined],
  ['old-grid-own', 'OldGrid', '--_cols-lg: 3'],
  ['old-grid-own-shown', 'OldGrid', 'gap: 1rem'],
  ['old-heading', 'OldHeading', '--_mw: 30ch;'],
  ['old-heading-default', 'OldHeading', undefined],
  ['button', 'Button', undefined],
  ['sealed', 'Sealed', undefined],
  ['missing', 'Missing', undefined],
];
const EDITABLE = ['grid-set', 'grid-default', 'heading', 'box', 'old-grid-default', 'old-heading-default', 'button', 'missing'];
const LOCKED = [
  ['old-grid', /^OldGrid\.astro writes this element’s style itself/],
  ['old-grid-own', /^OldGrid\.astro writes this element’s style itself/],
  ['old-heading', /^OldHeading\.astro writes this element’s style itself/],
  ['sealed', /^Sealed\.astro doesn’t pass a style/],
  ['coded', /chain of conditions/],
];
const OWN_STYLES = new Map([
  ['grid-own', 'gap: 1rem'],
  ['old-grid-own', 'gap: 1rem'],
  ['old-grid-own-shown', 'gap: 1rem'],
]);
const RELEASE_ROUNDS_MAX = 20;

const text = (value) => ({ type: 'string', value });
const instance = ([id, name]) => ({
  id,
  kind: 'component',
  name,
  props: OWN_STYLES.has(id) ? { style: text(OWN_STYLES.get(id)) } : {},
  children: [],
});
const FIXTURE = {
  sheets: [{ rel: 'src/styles/global.css', css: '.card { gap: 2rem; }\n.grid { gap: 3rem; }\n.list { gap: 4rem; }\n' }],
  nodes: [
    { id: 'plain', kind: 'element', name: 'div', props: { class: text('card') }, children: [] },
    ...INSTANCES.map(instance),
    { id: 'coded', kind: 'element', name: 'div', props: { class: text('list'), style: { type: 'expr', value: 'styles' } }, children: [] },
  ],
  markup:
    '<div class="card" data-avb-p="plain">a</div>' +
    INSTANCES.map(([id, , style]) => `<div class="grid"${style === undefined ? '' : ` style="${style}"`} data-avb-p="${id}">b</div>`).join('') +
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
    if (asked.endsWith('.astro')) {
      if (!COMPONENTS.has(asked)) {
        throw new Error('no such component');
      }
      return { css: COMPONENTS.get(asked) };
    }
    return readSheet(payload);
  };
  panel.inlineDefault(mode);
  const inlineWrites = [];
  counter += 1;
  let nodes = FIXTURE.nodes;
  // As the app does: the write lands in the page model, which the panel reads next.
  const onSetInlineStyle = (nodeId, style) => {
    inlineWrites.push([nodeId, style?.value]);
    nodes = nodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }
      const { style: _before, ...rest } = node.props;
      return { ...node, props: style === undefined ? rest : { ...rest, style } };
    });
    panel.rerender({ model: { nodes } });
  };
  panel.rerender({ project: { path: `/fixture-design-target-${counter}` }, onSetInlineStyle });
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
  const found = INSTANCES.find(([candidate]) => candidate === id);
  panel.rerender({ selectedComponentPath: found === undefined ? undefined : component(found[1]) });
}

const controls = (panel) => panel.container.querySelector('fieldset.embed-editor_controls');
const inlineChip = (panel) => panel.container.querySelector('button.embed-editor_selector-chip.is-inline');
const classChip = (panel, selector) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip:not(.is-inline)')].find((chip) => chip.textContent.trim() === selector);
const pressed = (panel) =>
  [...panel.container.querySelectorAll('button.embed-editor_selector-chip[aria-pressed="true"]')].map((chip) => chip.textContent.trim());
const button = (panel, label) => [...panel.container.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === label);

async function choose(panel, label, options) {
  const target = button(panel, label);
  assert.ok(target, `the panel offers ${label}`);
  await step(panel, `choose ${label}`, () => press(panel, target, options));
}

for (const id of ['plain', ...EDITABLE]) {
  test(`Design mode: ${id} starts on Inline styles, live, and an edit writes that node only`, async (context) => {
    const { panel, inlineWrites } = await mount(context);
    for (const round of ['select', 'reselect']) {
      await step(panel, `${round}: leave`, () => select(panel, 'coded'));
      await step(panel, round, () => select(panel, id));
      assert.deepEqual(pressed(panel), ['Inline styles'], round);
      assert.equal(controls(panel).disabled, false, round);
      assert.ok(inlineChip(panel).classList.contains('is-inline'));
      assert.equal(inlineChip(panel).classList.contains('is-code'), false, 'a style to write, not code');
    }
    await choose(panel, 'Flex');
    assert.deepEqual(inlineWrites, [[id, 'display: flex']]);
    assert.deepEqual(panel.writes, [], 'no stylesheet and no component file is written');
  });
}

test('Design mode: a combining instance’s own style is read back and edited, and its last declaration takes the attribute', async (context) => {
  const { panel, inlineWrites } = await mount(context);
  await step(panel, 'select the Grid', () => select(panel, 'grid-own'));
  await choose(panel, 'Flex');
  assert.deepEqual(inlineWrites.at(-1), ['grid-own', 'gap: 1rem; display: flex'], 'what was there is kept, the component’s value is not copied in');
  // Alt-click on the property's label resets it.
  await choose(panel, 'Display', { altKey: true });
  assert.deepEqual(inlineWrites.at(-1), ['grid-own', 'gap: 1rem;']);
  await step(panel, 'select another', () => select(panel, 'grid-default'));
  await choose(panel, 'Flex');
  await choose(panel, 'Display', { altKey: true });
  assert.deepEqual(inlineWrites.slice(-2), [
    ['grid-default', 'display: flex'],
    ['grid-default', undefined],
  ]);
  assert.deepEqual(pressed(panel), ['Inline styles']);
  assert.deepEqual(panel.writes, []);
});

for (const [id, why] of LOCKED) {
  test(`Design mode: ${id} keeps Inline styles, locked with why, and nothing is written`, async (context) => {
    const { panel, inlineWrites } = await mount(context);
    for (const round of ['select', 'reselect']) {
      await step(panel, `${round}: leave`, () => select(panel, 'plain'));
      await step(panel, round, () => select(panel, id));
      assert.deepEqual(pressed(panel), ['Inline styles'], round);
      assert.equal(controls(panel).disabled, true, round);
      assert.match(controls(panel).title, why, 'hovering the controls says why');
    }
    await step(panel, 'press a locked control', () => button(panel, 'Flex')?.click());
    assert.deepEqual(inlineWrites, []);
    assert.deepEqual(panel.writes, [], 'no stylesheet and no component file is written');
  });
}

test('Design mode: an old Grid whose own style is what renders is edited on that style', async (context) => {
  const { panel, inlineWrites } = await mount(context);
  await step(panel, 'select it', () => select(panel, 'old-grid-own-shown'));
  assert.equal(controls(panel).disabled, false);
  await choose(panel, 'Flex');
  assert.deepEqual(inlineWrites, [['old-grid-own-shown', 'gap: 1rem; display: flex']]);
});

for (const id of ['old-grid-default', 'button']) {
  test(`editor: ${id} behaves as before, with no chip until it has a style`, async (context) => {
    const { panel } = await mount(context, 'selector');
    await step(panel, 'select it', () => select(panel, id));
    assert.equal(inlineChip(panel) ?? undefined, undefined);
    assert.equal(controls(panel).disabled, false);
  });
}

test('Design mode: the person picking the class is what makes a locked Grid editable, in that rule', async (context) => {
  const { panel, inlineWrites } = await mount(context);
  await step(panel, 'select the Grid', () => select(panel, 'old-grid'));
  assert.match(inlineChip(panel).title, /^OldGrid\.astro writes this/, 'the chip says why too');
  await step(panel, 'pick the class', () => press(panel, classChip(panel, '.grid')));
  assert.deepEqual(pressed(panel), ['.grid']);
  assert.equal(controls(panel).disabled, false);
  assert.equal(controls(panel).title, '');
  await choose(panel, 'Flex');
  assert.match(panel.writes.map((write) => write.css).join('\n'), /display: flex/);
  assert.deepEqual(inlineWrites, []);
});

for (const id of ['plain', 'grid-set', 'grid-default', 'heading', 'old-grid']) {
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
    assert.equal(controls(panel).disabled, id === 'old-grid');
  });
}

for (const id of ['grid-set', 'heading']) {
  test(`editor: the chip picked on a combining instance (${id}) edits the instance, not the component’s file`, async (context) => {
    const { panel, inlineWrites } = await mount(context, 'selector');
    await step(panel, 'select it', () => select(panel, id));
    assert.deepEqual(pressed(panel), ['.grid'], 'the editor starts on the class, as ever');
    await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
    assert.equal(controls(panel).disabled, false);
    await choose(panel, 'Flex');
    assert.deepEqual(inlineWrites, [[id, 'display: flex']]);
    assert.deepEqual(panel.writes, []);
  });
}

test('editor: a Heading that does not combine still edits the component’s own style, as before', async (context) => {
  const { panel, inlineWrites } = await mount(context, 'selector');
  await step(panel, 'select it', () => select(panel, 'old-heading'));
  await step(panel, 'pick the chip', () => press(panel, inlineChip(panel)));
  assert.equal(controls(panel).disabled, false);
  assert.doesNotMatch(inlineChip(panel).title, /writes this element’s style itself/);
  await choose(panel, 'Flex');
  assert.deepEqual(inlineWrites, []);
  assert.match(panel.writes.map((write) => write.css).join('\n'), /--_mw: \$\{maxWidth\}ch;\s*display: flex/);
});

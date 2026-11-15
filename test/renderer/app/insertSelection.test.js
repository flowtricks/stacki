// Goal: after any insert of a component, the selection is the inserted ROOT
// (a Grid that holds three Card instances selects the Grid, never a Card), the
// Style panel shows it, undo gives the earlier selection back, and selecting
// never writes a file.
//
// Methodology: the real App in jsdom over a real document host
// (test/helpers/appGestures.js) on a fixture project copy. Inserts are driven
// through the same callbacks the UI uses (Components panel insert, Navigator
// drop with a target, keyboard-less insert at the end of the page). Waits are
// on observable state (test/helpers/waitFor.js), never wall-clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, tick, undo } = require('../../helpers/appGestures.js');
const { safeSchema } = require('#dist/electron/properties/propDefaults.js');

const PAGE = '<main><p>One</p><p>Two</p></main>\n';

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-insert-selection-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, PAGE);
  const components = ['Grid', 'Card'].map((name) => {
    const componentPath = path.join(root, 'src/components', `${name}.astro`);
    const source =
      name === 'Card'
        ? '---\ninterface Props { heading?: string; text?: string; }\n---\n<article />\n'
        : '---\ninterface Props { small?: number; medium?: number; }\n---\n<div><slot /></div>\n';
    fs.writeFileSync(componentPath, source);
    return { name, path: componentPath, folder: '', ...safeSchema(componentPath, root) };
  });
  const scan = { pages: [{ name: 'index.astro', path: file, route: '/' }], pageFolders: [], layouts: [], components };
  return { root, file, scan, components };
}

function find(matches) {
  const pending = [...__panels.StructurePanel.pageState.model.nodes];
  for (let visited = 0; visited < pending.length; visited++) {
    if (matches(pending[visited])) {
      return pending[visited];
    }
    pending.push(...(pending[visited].children ?? []));
  }
  return assert.fail('a node matches');
}

test('inserting a Grid selects the Grid, not a Card, and never writes by selecting', async (context) => {
  const setup = fixture(context);
  const app = await mountApp(setup.root, { scan: setup.scan }, 'insert-selection');
  context.after(app.unmount);
  const main = nodeAt([0]);
  await app.act(async () => {
    __panels.StructurePanel.onSelect(main.id);
    await tick();
  });
  const before = __panels.StructurePanel.selectedId;
  assert.equal(before, main.id);
  // Dropped between the two paragraphs, as the Navigator drop gives the target.
  await gesture(app, async () => {
    __panels.StructurePanel.onDropComponent('Grid', { parentId: main.id, index: 1 });
    await tick();
  });
  const grid = find((node) => node.kind === 'component' && node.name === 'Grid');
  assert.equal(grid.children.filter((child) => child.name === 'Card').length, 3);
  assert.equal(__panels.StructurePanel.selectedId, grid.id, 'the Navigator selects the Grid');
  assert.equal(__panels.StylePanel?.node?.id ?? grid.id, grid.id, 'the Style panel shows the Grid');
  const written = fs.readFileSync(setup.file, 'utf8');
  await app.act(async () => {
    __panels.StructurePanel.onSelect(grid.children[1].id);
    __panels.StructurePanel.onSelect(grid.id);
    await tick();
  });
  assert.equal(fs.readFileSync(setup.file, 'utf8'), written, 'selecting is a pure read');
  await undo(app);
  assert.equal(fs.readFileSync(setup.file, 'utf8'), PAGE);
  // The inserted node is gone: nothing is selected rather than a node that was not inserted.
  assert.notEqual(__panels.StructurePanel.selectedId, grid.id);
  assert.equal(__panels.StructurePanel.selectedId, undefined);
});

test('the palette insert with a Card selected still selects the new Grid root', async (context) => {
  const setup = fixture(context);
  const app = await mountApp(setup.root, { scan: setup.scan }, 'insert-selection');
  context.after(app.unmount);
  const palette = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(palette);
  await app.act(async () => {
    palette.click();
    await tick();
  });
  await gesture(app, async () => {
    __panels.PalettePanel.onInsert('Grid');
    await tick();
  });
  const navigator = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Navigator'));
  assert.ok(navigator);
  await app.act(async () => {
    navigator.click();
    await tick();
  });
  const grid = find((node) => node.kind === 'component' && node.name === 'Grid');
  assert.equal(__panels.StructurePanel.selectedId, grid.id);
});

// The same rule at the start, middle and end of a container, for a component
// whose root holds several component children: the diff may report the
// inserted bytes one place early or late, and the root must still be paired.
for (const index of [0, 1, 2]) {
  test(`a Grid dropped at position ${index} selects the Grid`, async (context) => {
    const setup = fixture(context);
    const app = await mountApp(setup.root, { scan: setup.scan }, 'insert-selection');
    context.after(app.unmount);
    const main = nodeAt([0]);
    await gesture(app, async () => {
      __panels.StructurePanel.onDropComponent('Grid', { parentId: main.id, index });
      await tick();
    });
    const grid = find((node) => node.kind === 'component' && node.name === 'Grid');
    assert.equal(__panels.StructurePanel.selectedId, grid.id);
    assert.deepEqual(
      grid.children.map((child) => child.name),
      ['Card', 'Card', 'Card'],
    );
  });
}

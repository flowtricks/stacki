// Exercise the Desktop host with the real App, parser, document actor, and metadata writer.
// The navigator callback opens an isolated copy; closing saves defaults and restores the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mountApp, nodeAt, gesture, tick } = require('../../helpers/appGestures.js');
const { safeSchema } = require('#dist/electron/properties/propDefaults.js');
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-defaults-flow-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, '.stacki/canvas'), { recursive: true });
  const component = path.join(root, 'src/components/Heading.astro');
  fs.writeFileSync(component, '---\ninterface Props { level?: number; }\n---\n<h2><slot /></h2>');
  const layout = path.join(root, 'src/layouts/BaseLayout.astro');
  fs.mkdirSync(path.dirname(layout), { recursive: true });
  fs.writeFileSync(layout, '---\ninterface Props { title?: string; }\n---\n<html><slot /></html>');
  const file = path.join(root, 'src/pages/index.astro');
  const source =
    '---\nimport Hero from "../components/Heading.astro";\n' +
    'import Layout from "../layouts/BaseLayout.astro";\n---\n' +
    '<Layout><p>Before</p><Hero>Instance</Hero><p>After</p></Layout>';
  fs.writeFileSync(file, source);
  fs.writeFileSync(
    path.join(root, '.stacki/components.json'),
    JSON.stringify({
      version: 1,
      components: {
        'src/components/Heading.astro': { text: 'Default' },
        'src/layouts/BaseLayout.astro': {},
      },
    }),
  );
  return {
    root,
    file,
    source,
    scan: {
      pages: [{ name: 'index.astro', path: file, route: '/' }],
      pageFolders: [],
      layouts: [{ name: 'BaseLayout', path: layout, folder: '', ...safeSchema(layout, root) }],
      components: [{ name: 'Heading', path: component, folder: '', ...safeSchema(component, root) }],
    },
  };
}
test('Desktop defaults preserve context and restore the original instance', async (context) => {
  const setup = fixture(context);
  const app = await mountApp(setup.root, { scan: setup.scan }, 'desktop-defaults-flow', {
    bridge: {
      createDefaultsCanvas: async ({ canvas }) => {
        fs.writeFileSync(path.join(setup.root, canvas.file), canvas.source);
        return { file: canvas.file };
      },
      removeDefaultsCanvas: async ({ file }) => fs.rmSync(path.join(setup.root, file)),
    },
  });
  context.after(app.unmount);
  await app.act(async () => {
    __panels.StructurePanel.onSelect(nodeAt([0, 1]).id);
    await tick();
  });
  await app.act(async () => {
    const node = nodeAt([0, 1]);
    __panels.StructurePanel.onSetDefaults(node.name, node.id);
    await tick();
  });
  assert.equal(nodeAt([0, 1, 0]).value, 'Default');
  assert.ok(__panels.PropsPanel.schema.some((field) => field.name === 'level'));
  assert.equal(__panels.PropsPanel.valuePolicy, 'defaults');
  assert.equal(nodeAt([0, 0, 0]).value, 'Before');
  assert.equal(nodeAt([0, 2, 0]).value, 'After');
  assert.equal(__panels.PreviewPane.focusPath, '0.1');
  assert.equal(__panels.StructurePanel.editRootId, nodeAt([0, 1]).id);
  await gesture(app, async () => {
    document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      }),
    );
    __panels.PreviewPane.onCrumb(nodeAt([0]).id);
    await tick();
  });
  assert.equal(nodeAt([0, 1, 0]).value, 'Default');
  assert.equal(__panels.StructurePanel.selectedId, nodeAt([0, 1]).id);
  const close = document.querySelector('[aria-label="Close defaults"]');
  assert.ok(close);
  await gesture(app, async () => {
    close.click();
    await tick();
  });
  assert.equal(nodeAt([0, 1, 0]).value, 'Instance');
  assert.equal(__panels.StructurePanel.selectedId, nodeAt([0, 1]).id);
  assert.equal(fs.readFileSync(setup.file, 'utf8'), setup.source);
  assert.deepEqual(fs.readdirSync(path.join(setup.root, '.stacki/canvas')), []);
  assert.equal(document.querySelector('[aria-label="Close defaults"]') ?? undefined, undefined);
  await checkLayoutDefaults(app, setup);
  await checkOutsideClose(app, setup);
});

async function checkLayoutDefaults(app, setup) {
  await app.act(async () => {
    __panels.StructurePanel.onSetDefaults('Layout', nodeAt([0]).id);
    await tick();
  });
  assert.ok(__panels.PropsPanel.schema.some((field) => field.name === 'title'));
  assert.equal(nodeAt([0]).children, undefined);
  await gesture(app, async () => {
    document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
  });
  assert.equal(fs.readFileSync(setup.file, 'utf8'), setup.source);
}

async function checkOutsideClose(app, setup) {
  await app.act(async () => {
    const node = nodeAt([0, 1]);
    __panels.StructurePanel.onSetDefaults(node.name, node.id);
    await tick();
  });
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('level', { type: 'expr', value: '3' }, true);
    await tick();
  });
  assert.equal(__panels.PropsPanel.node.props.level.value, '3');
  await gesture(app, async () => {
    __panels.PreviewPane.onSelectPath(undefined, { outside: true });
    await tick();
  });
  assert.equal(document.querySelector('[aria-label="Close defaults"]') ?? undefined, undefined);
  assert.equal(fs.readFileSync(setup.file, 'utf8'), setup.source);
  const defaults = JSON.parse(fs.readFileSync(path.join(setup.root, '.stacki/components.json')));
  assert.equal(defaults.components['src/components/Heading.astro'].props.level, 3);
}

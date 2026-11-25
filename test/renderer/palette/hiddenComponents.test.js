// Goal: what a role's hidden-component rules do in the editor's lists. For every role but admin a hidden component
// is gone from the insert palette (All results, the Components tab, folder pills and counts), the Components panel,
// the Tag field's suggestions and the layout choices, and Desktop's add guard refuses it. An admin keeps it in the
// Components panel (its own filter box too), dimmed with a tip, and may add it, but no search offers it. The Elements
// tab is untouched, a show rule brings a component back, and "View as" and a role change update the lists at once.
// Method: bundle the real palette, panel, role store and option builders, mount them in jsdom with generated
// components, set the active role, and read the rendered rows and pills; the guard is checked on its own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'hidden-components.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as InsertSearch } from './src/features/palette/InsertSearch';",
      "export { default as PalettePanel } from './src/features/palette/PalettePanel';",
      "export { setActualRole, setViewAs } from './src/lib/currentRole';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
      "export { componentsOfferedTo, canAddComponent, assertCanAddComponent } from './src/features/palette/componentVisibility';",
      "export { tagOptionsOf, layoutOptionsOf } from './src/app/model/pageModelGestures';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});
const palette = require(output);

const COMPONENTS = [
  { name: 'Card', folder: '', file: 'src/components/Card.astro', path: '/p/src/components/Card.astro' },
  { name: 'Modal', folder: 'interactive', file: 'src/components/interactive/Modal.astro', path: '/p/src/components/interactive/Modal.astro' },
  { name: 'Tabs', folder: 'interactive', file: 'src/components/interactive/Tabs.astro', path: '/p/src/components/interactive/Tabs.astro' },
  { name: 'Button', folder: 'ui', file: 'src/components/ui/Button.astro', path: '/p/src/components/ui/Button.astro' },
];
const role = (rules) => ({ ...palette.ADMIN_VIEW, id: 'client', name: 'Client', isAdmin: false, features: new Set(), componentRules: rules });
const hideInteractive = [{ kind: 'folder', path: 'src/components/interactive', effect: 'hide' }];

async function mount(element) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => root.render(element(React)));
  return {
    container,
    act: (run) => React.act(async () => run()),
    async unmount() {
      await React.act(async () => root.unmount());
      dom.window.close();
    },
  };
}
const searchProps = { components: COMPONENTS, onInsert() {}, onClose() {} };
const labels = (container) => [...container.querySelectorAll('.insert-item-label')].map((row) => row.textContent);

test('the palette lists every component to a role with no rules, and omits hidden ones for a restricted role', async () => {
  palette.setActualRole(palette.ADMIN_VIEW);
  const everyone = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  assert.deepEqual(
    labels(everyone.container)
      .filter((label) => ['Card', 'Modal', 'Tabs', 'Button'].includes(label))
      .sort(),
    ['Button', 'Card', 'Modal', 'Tabs'],
  );
  await everyone.unmount();
  palette.setActualRole(role(hideInteractive));
  const view = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  const shown = labels(view.container);
  assert.ok(shown.includes('Card') && shown.includes('Button'));
  assert.ok(!shown.includes('Modal') && !shown.includes('Tabs'), 'hidden components are not in the results');
  assert.ok(
    shown.some((label) => label === '<div>'),
    'elements are not affected',
  );
  await view.unmount();
});

test('the Components tab drops a fully hidden folder pill, and a show rule brings one component back with its pill', async () => {
  palette.setActualRole(role(hideInteractive));
  const hidden = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  await hidden.act(() => [...hidden.container.querySelectorAll('.insert-tab')].find((tab) => tab.textContent === 'Components').click());
  const pills = () => [...hidden.container.querySelectorAll('.insert-pill')].map((pill) => pill.textContent);
  assert.ok(!pills().some((text) => text.startsWith('interactive')), 'a fully hidden folder has no pill');
  assert.ok(pills().some((text) => text.startsWith('ui')));
  await hidden.unmount();
  palette.setActualRole(role([...hideInteractive, { kind: 'component', path: 'src/components/interactive/Tabs.astro', effect: 'show' }]));
  const shown = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  await shown.act(() => [...shown.container.querySelectorAll('.insert-tab')].find((tab) => tab.textContent === 'Components').click());
  assert.ok(
    [...shown.container.querySelectorAll('.insert-pill')].some((pill) => pill.textContent.startsWith('interactive')),
    'the pill returns with the shown component',
  );
  await shown.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

const hiddenAdmin = { ...palette.ADMIN_VIEW, componentRules: hideInteractive };
const panelProps = {
  components: COMPONENTS,
  trailingSlash: 'ignore',
  createFrom: { kind: 'unavailable', reason: '' },
  onInsert() {},
  onCreateComponent() {},
};
const rowNames = (container) => [...container.querySelectorAll('.palette-item .label')].map((row) => row.firstChild.textContent);

test('an admin\'s hidden component is out of the palette, and "View as" shows the viewed role\'s list', async () => {
  palette.setActualRole(hiddenAdmin);
  const view = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  assert.ok(!labels(view.container).includes('Modal') && !labels(view.container).includes('Tabs'), "search leaves an admin's hidden component out");
  assert.ok(labels(view.container).includes('Button'));
  await view.act(() => palette.setViewAs(role([{ kind: 'folder', path: 'src/components/ui', effect: 'hide' }])));
  assert.ok(!labels(view.container).includes('Button'), 'viewing as another role swaps the rules');
  assert.ok(labels(view.container).includes('Modal'));
  await view.act(() => palette.setViewAs(undefined));
  await view.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

test("the Components panel keeps an admin's hidden components, dimmed, addable by hand and found by its filter", async () => {
  palette.setActualRole(hiddenAdmin);
  const added = [];
  const panel = await mount((React) => React.createElement(palette.PalettePanel, { ...panelProps, onInsert: (target) => added.push(target) }));
  assert.deepEqual(rowNames(panel.container).sort(), ['Button', 'Card', 'Modal', 'Tabs']);
  const dimmed = [...panel.container.querySelectorAll('.palette-item.is-search-hidden .label')].map((row) => row.firstChild.textContent);
  assert.deepEqual(dimmed.sort(), ['Modal', 'Tabs']);
  const row = [...panel.container.querySelectorAll('.palette-item.is-search-hidden')][0];
  assert.equal(row.getAttribute('draggable'), 'true');
  assert.equal(row.querySelector('.icon').getAttribute('aria-label'), 'Hidden from search');
  assert.ok(row.querySelector('.palette-row-menu'), 'the row keeps its menu');
  await panel.act(() => row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.equal(added.length, 1, 'double-click adds it');
  const input = panel.container.querySelector('input');
  // React was loaded before this DOM existed, so it listens for no input event here: the box's own handler is called.
  const handlers = input[Object.keys(input).find((key) => key.startsWith('__reactProps'))];
  await panel.act(() => handlers.onChange({ target: { value: 'modal' }, currentTarget: { value: 'modal' } }));
  assert.deepEqual(rowNames(panel.container), ['Modal'], "the panel's own box only narrows the panel");
  await panel.act(() => palette.setViewAs(role(hideInteractive)));
  assert.deepEqual(rowNames(panel.container), [], 'as another role they are gone from the panel too');
  await panel.act(() => palette.setViewAs(undefined));
  await panel.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

test('the Components panel lists nothing hidden to any other role, and dims nothing', async () => {
  palette.setActualRole(role(hideInteractive));
  const panel = await mount((React) => React.createElement(palette.PalettePanel, panelProps));
  assert.deepEqual(rowNames(panel.container).sort(), ['Button', 'Card']);
  assert.ok(!panel.container.querySelector('.is-search-hidden'));
  await panel.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

test('the Tag field suggests no hidden component, imported ones included, and layout choices mark hidden layouts', () => {
  const imports = [{ name: 'Modal' }, { name: 'Logo' }];
  for (const viewer of [hiddenAdmin, role(hideInteractive)]) {
    const names = palette.tagOptionsOf(COMPONENTS, imports, viewer).map((option) => option.name);
    assert.ok(names.includes('Card') && names.includes('Logo') && names.includes('div'));
    assert.ok(!names.includes('Modal') && !names.includes('Tabs'));
  }
  assert.ok(palette.tagOptionsOf(COMPONENTS, imports, palette.ADMIN_VIEW).some((option) => option.name === 'Modal'));
  const namesake = [...COMPONENTS, { name: 'Modal', file: 'src/components/ui/Modal.astro' }];
  assert.ok(
    palette.tagOptionsOf(namesake, [], hiddenAdmin).some((option) => option.name === 'Modal'),
    'a shown namesake keeps the name offered',
  );
  const layouts = [
    { name: 'Base', file: 'src/layouts/Base.astro', isLayout: true },
    { name: 'Bare', file: 'src/layouts/Bare.astro', isLayout: true },
  ];
  const hideBare = [{ kind: 'component', path: 'src/layouts/Bare.astro', effect: 'hide' }];
  assert.deepEqual(palette.layoutOptionsOf(layouts, role(hideBare)), [
    { name: 'Base', kind: 'layout' },
    { name: 'Bare', kind: 'layout', unlisted: true },
  ]);
  assert.deepEqual(
    palette.componentsOfferedTo(role(hideBare), 'browse', layouts).map((item) => item.name),
    ['Base'],
  );
  assert.equal(palette.componentsOfferedTo({ ...palette.ADMIN_VIEW, componentRules: hideBare }, 'browse', layouts).length, 2);
});

test('the add guard lets an admin add a hidden component, refuses any other role, and never touches package components', () => {
  const restricted = role(hideInteractive);
  assert.deepEqual(
    palette.componentsOfferedTo(restricted, 'browse', COMPONENTS).map((item) => item.name),
    ['Card', 'Button'],
  );
  assert.equal(palette.componentsOfferedTo(palette.ADMIN_VIEW, 'search', COMPONENTS), COMPONENTS, 'no rules, no copy');
  assert.equal(palette.canAddComponent(restricted, { name: 'Pkg', origin: { kind: 'package' } }), true);
  assert.equal(palette.canAddComponent(restricted, { name: 'Modal', folder: 'interactive' }), false, 'the folder convention names the file of an older scan');
  assert.throws(() => palette.assertCanAddComponent(restricted, COMPONENTS[1]), /Your role \(Client\) cannot add Modal/);
  palette.assertCanAddComponent(restricted, COMPONENTS[0]);
  palette.assertCanAddComponent(hiddenAdmin, COMPONENTS[1]);
});

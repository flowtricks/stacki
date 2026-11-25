// Goal: a component a role's rules hide is absent from every list that adds components: the palette's All
// results and Components tab (results, folder pills and their counts), and the Components panel; the Elements
// tab is untouched; a folder whose components are all hidden loses its pill; a show rule brings one back;
// "View as" and a role change update the lists at once; admin can be restricted too; and Desktop's add guard
// refuses a hidden component while a component already on the page is not affected (the guard only runs when adding).
// Method: bundle the real palette, panel and role store, mount them in jsdom with generated components, set the
// active role, and read the rendered rows and pills; the pure filter and guard are checked on their own.
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
      "export { componentsAddableBy, canAddComponent, assertCanAddComponent } from './src/features/palette/componentVisibility';",
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

test('an admin can be restricted, and "View as" shows the viewed role\'s list', async () => {
  const restrictedAdmin = { ...palette.ADMIN_VIEW, componentRules: [{ kind: 'folder', path: 'src/components/ui', effect: 'hide' }] };
  palette.setActualRole(restrictedAdmin);
  const view = await mount((React) => React.createElement(palette.InsertSearch, searchProps));
  assert.ok(!labels(view.container).includes('Button'));
  assert.ok(labels(view.container).includes('Modal'));
  await view.act(() => palette.setViewAs(role(hideInteractive)));
  assert.ok(labels(view.container).includes('Button'), 'viewing as another role swaps the rules');
  assert.ok(!labels(view.container).includes('Modal'));
  await view.act(() => palette.setViewAs(undefined));
  await view.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

test('the Components panel lists only what the role may add', async () => {
  palette.setActualRole(role(hideInteractive));
  const panel = await mount((React) =>
    React.createElement(palette.PalettePanel, {
      components: COMPONENTS,
      trailingSlash: 'ignore',
      createFrom: { kind: 'unavailable', reason: '' },
      onInsert() {},
      onCreateComponent() {},
    }),
  );
  const text = panel.container.textContent;
  assert.match(text, /Card/);
  assert.match(text, /Button/);
  assert.doesNotMatch(text, /Modal|Tabs/);
  await panel.unmount();
  palette.setActualRole(palette.ADMIN_VIEW);
});

test('the pure filter and the add guard agree, never touch package components, and refuse with a described error', () => {
  const restricted = role(hideInteractive);
  assert.deepEqual(
    palette.componentsAddableBy(restricted, COMPONENTS).map((item) => item.name),
    ['Card', 'Button'],
  );
  assert.equal(palette.componentsAddableBy(palette.ADMIN_VIEW, COMPONENTS), COMPONENTS, 'no rules, no copy');
  assert.equal(palette.canAddComponent(restricted, { name: 'Pkg', origin: { kind: 'package' } }), true);
  assert.equal(palette.canAddComponent(restricted, { name: 'Modal', folder: 'interactive' }), false, 'the folder convention names the file of an older scan');
  assert.throws(() => palette.assertCanAddComponent(restricted, COMPONENTS[1]), /Your role \(Client\) cannot add Modal/);
  palette.assertCanAddComponent(restricted, COMPONENTS[0]);
});

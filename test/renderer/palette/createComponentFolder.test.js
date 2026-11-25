// Goal: the Create component dialog asks where the new component goes. Its Folder field, under Name, is the custom dropdown (never a
// native select) and starts on the components root every time; it lists every folder below the root that holds a component, nested
// ones as paths, and a last "New folder…" row that opens a field for a typed path. The name field's tooltip says the file it will be
// saved as, live (no paragraph under the field); a typed folder that climbs out, starts at the disk, has an empty level or a bad
// character takes the error look and Create disabled, with its reason as one toast when Create is tried (no text row under the
// field); a name is taken only in the chosen folder, and the same name in another folder is a warning (tooltip and toast), not a
// refusal. Creating hands the host the folder below the root, `''` for the root.
// "Move styles" lists the classes whose CSS may go into the component, read when the dialog opens, none checked to begin
// with, each with where its CSS is; absent when there is nothing to read or nothing to move; and Create hands over the checked ones.
// Method: bundle the real PalettePanel, mount it in jsdom with components in nested folders and a stub management whose rename
// host names the configured roots, open the dialog with the header button, and drive the real dropdown and inputs with clicks
// and input events; the host's onCreateComponent records what it is handed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'create-component-folder.cjs');
buildSync({
  stdin: {
    contents: ["export { default as PalettePanel } from './src/features/palette/PalettePanel';"].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  loader: { '.css': 'empty', '.svg': 'empty' },
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});

const component = (name, folder) => ({
  name,
  folder,
  path: `/p/src/components/${folder ? folder + '/' : ''}${name}.astro`,
  file: `src/components/${folder ? folder + '/' : ''}${name}.astro`,
  instances: 0,
});
const COMPONENTS = [component('Button', ''), component('Field', 'Form'), component('Header', 'Global/Layout'), component('Card', 'Interactive')];

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.localStorage = dom.window.localStorage;
// After the globals: react-dom reads the DOM it runs in once, when it loads.
const lib = require(output);

async function mount(sourceName, styles) {
  document.body.innerHTML = '<div id="root"></div>';
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  global.requestAnimationFrame = dom.window.requestAnimationFrame;
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const created = [];
  const management = {
    editSettings() {},
    duplicate() {},
    remove() {},
    rename: { roots: ['src/components'], plan: async () => ({ ok: true, value: { files: [], notices: [] } }), apply() {} },
  };
  await React.act(async () =>
    root.render(
      React.createElement(lib.PalettePanel, {
        components: COMPONENTS,
        trailingSlash: 'ignore',
        devUrl: undefined,
        createFrom: {
          kind: 'ready',
          name: sourceName,
          label: '<div>',
          plan: () => ({ values: [], props: [], moved: { imports: [], code: '' }, parent: { imports: [], extraFrontmatter: '' } }),
          ...(styles === undefined ? {} : { styles }),
        },
        onInsert() {},
        onCreateComponent: (name, options) => created.push({ name, ...options }),
        onUsage: async () => ({ files: [] }),
        management,
      }),
    ),
  );
  const act = (run) => React.act(async () => run());
  const view = {
    created,
    act,
    modal: () => document.querySelector('.modal.create-component'),
    // The name field's tooltip text, which the field also names with aria-describedby for a screen reader.
    hint: () => document.querySelector('.modal .tip-anchor .info-hint-text')?.textContent ?? '',
    trigger: () => document.querySelector('.modal .create-folder .dd-trigger'),
    options: () => [...document.querySelectorAll('.dd-option')].map((option) => option.textContent.trim()),
    createButton: () => [...document.querySelectorAll('.modal-footer button')].find((button) => button.textContent === 'Create'),
    folderText: () => document.querySelector('.modal .create-folder')?.textContent ?? '',
    async type(input, value) {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(() => {
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    },
    async pick(label) {
      await act(() => view.trigger().click());
      const option = [...document.querySelectorAll('.dd-option')].find((row) => row.textContent.trim() === label);
      assert.ok(option, `the folder list offers ${label}`);
      await act(() => option.click());
    },
    async unmount() {
      await React.act(async () => root.unmount());
    },
  };
  await act(() => [...document.querySelectorAll('.panel-header button')].pop().click());
  assert.ok(view.modal(), 'the dialog opens');
  return view;
}

test('the folder field is the custom dropdown under Name, on the components root by default', async () => {
  const view = await mount('Div');
  assert.ok(view.modal().querySelector('select') === null, 'no native select');
  const labels = [...view.modal().querySelectorAll('label')].map((label) => label.textContent);
  assert.ok(labels.indexOf('Folder') > labels.indexOf('Name'), 'Folder sits under Name');
  assert.equal(view.trigger().textContent.trim(), 'components (root)');
  assert.match(view.hint(), /saved as src\/components\/Div\.astro/);
  await view.act(() => view.createButton().click());
  assert.deepEqual(view.created, [{ name: 'Div', asProp: [], folder: '', moveStyles: [] }], 'the root is handed over as an empty folder');
  await view.unmount();
});

test('the list holds the root, every folder holding a component and the folders between, and New folder… last', async () => {
  const view = await mount('Div');
  await view.act(() => view.trigger().click());
  assert.deepEqual(view.options(), ['components (root)', 'Form', 'Global', 'Global/Layout', 'Interactive', 'New folder…']);
  await view.unmount();
});

test('choosing a nested folder updates the hint and is what Create hands over', async () => {
  const view = await mount('Div');
  await view.pick('Global/Layout');
  assert.match(view.hint(), /saved as src\/components\/Global\/Layout\/Div\.astro/);
  await view.act(() => view.createButton().click());
  assert.deepEqual(view.created, [{ name: 'Div', asProp: [], folder: 'Global/Layout', moveStyles: [] }]);
  await view.unmount();
});

test('a typed new nested folder is normalized, case folded onto an existing folder, and handed over', async () => {
  const view = await mount('Div');
  await view.pick('New folder…');
  const input = view.modal().querySelector('.create-folder-input');
  assert.ok(input, 'a field opens for the new folder');
  assert.equal(view.createButton().disabled, true, 'nothing typed yet: Create waits');
  await view.type(input, 'global/hero cards');
  assert.match(view.hint(), /saved as src\/components\/Global\/HeroCards\/Div\.astro/);
  assert.equal(view.createButton().disabled, false);
  await view.act(() => view.createButton().click());
  assert.deepEqual(view.created, [{ name: 'Div', asProp: [], folder: 'Global/HeroCards', moveStyles: [] }]);
  await view.unmount();
});

test('an invalid typed folder takes the error look and Create disabled; the reason is one toast on Enter, never a text row', async () => {
  const cases = [
    ['../pages', /“\.\.” can’t be used/],
    ['/Global', /no \/ or drive at the front/],
    ['Global//Layout', /Each level needs a name/],
    ['Glo*bal', /“\*” can’t be used in a name/],
  ];
  for (const [typed, reason] of cases) {
    const view = await mount('Div');
    await view.pick('New folder…');
    const input = view.modal().querySelector('.create-folder-input');
    await view.type(input, typed);
    assert.equal(input.getAttribute('aria-invalid'), 'true', `${typed} wears the error look`);
    assert.equal(view.modal().querySelector('.create-folder-problem') ?? undefined, undefined, 'no problem row under the field');
    assert.doesNotMatch(view.folderText(), reason, `${typed} adds no text under the field`);
    assert.equal(view.createButton().disabled, true, `${typed} cannot be created`);
    await view.act(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.match(toastMessages(), reason, `${typed} says why in a toast`);
    assert.deepEqual(view.created, [], `${typed} created nothing`);
    assert.match(view.hint(), /saved as src\/components\/…\/Div\.astro/, `${typed} names no folder in the hint`);
    await view.unmount();
  }
});

test('a name is taken only in the chosen folder, and the same name elsewhere is a warning', async () => {
  const view = await mount('Field');
  assert.equal(view.createButton().disabled, false, 'Field is free in the root');
  assert.match(view.hint(), /Another component is also called Field \(src\/components\/Form\/Field\.astro\)/, 'the tooltip carries the warning');
  assert.doesNotMatch(
    [...view.modal().querySelectorAll('div, p')]
      .filter((node) => node.children.length === 0 && !node.closest('.info-hint-text'))
      .map((node) => node.textContent)
      .join(' '),
    /Another component is also called/,
    'no warning paragraph in the dialog',
  );
  assert.match(toastMessages(), /Another component is also called Field/, 'and it warns once with a toast');
  await view.pick('Form');
  assert.equal(view.createButton().disabled, true, 'but taken in Form');
  assert.match(toastMessages(), /src\/components\/Form\/Field\.astro already exists/, 'and says which file holds the name');
  await view.unmount();
});

test('the dialog forgets the folder: it opens on the root again', async () => {
  const view = await mount('Div');
  await view.pick('Form');
  await view.act(() => view.createButton().click());
  await view.act(() => [...document.querySelectorAll('.panel-header button')].pop().click());
  assert.equal(view.trigger().textContent.trim(), 'components (root)');
  await view.unmount();
});

// "Move styles": the classes whose CSS may go into the component, read when the dialog opens.
const CANDIDATES = [
  { name: 'card', homes: [{ kind: 'stylesheet', rel: 'src/styles/base.css' }, { kind: 'page' }], reach: { kind: 'onlyHere' } },
  { name: 'centered', homes: [{ kind: 'stylesheet', rel: 'src/styles/base.css' }], reach: { kind: 'files', files: ['src/pages/about.astro'] } },
];
const styleRows = () => [...document.querySelectorAll('.modal .move-styles .extract-value')];
const styleSection = () => document.querySelector('.modal .move-styles') ?? undefined;

test('Move styles: absent where the host cannot move CSS, and when no class of the markup has CSS', async () => {
  const without = await mount('Div');
  assert.equal(styleSection(), undefined, 'no loader: no section');
  await without.unmount();
  const empty = await mount('Div', async () => []);
  await empty.act(() => undefined);
  assert.equal(styleSection(), undefined, 'nothing to move: no section');
  await empty.unmount();
});

test('Move styles: a row per class, none checked, with where its CSS is; Create with none checked moves nothing', async () => {
  const view = await mount('Div', async () => CANDIDATES);
  await view.act(() => undefined);
  const rows = styleRows();
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector('.extract-value-name').textContent,
      row.querySelector('input').checked,
      row.querySelector('.move-style-home').textContent,
    ]),
    [
      ['.card', false, 'base.css, This page'],
      ['.centered', false, 'base.css'],
    ],
  );
  assert.ok(rows[0].querySelector('.extract-value-tag') === null, 'a class only here wears no tag');
  assert.match(rows[1].querySelector('.extract-value-tag').textContent, /Also used elsewhere/);
  assert.equal(rows[1].querySelector('input').getAttribute('aria-label'), 'Move the styles of .centered');
  assert.equal(view.createButton().disabled, false, 'Create works with nothing checked');
  await view.act(() => view.createButton().click());
  assert.deepEqual(view.created, [{ name: 'Div', asProp: [], folder: '', moveStyles: [] }]);
  await view.unmount();
});

test('Move styles: checking and unchecking change what Create hands over', async () => {
  const view = await mount('Div', async () => CANDIDATES);
  await view.act(() => undefined);
  await view.act(() => styleRows()[0].querySelector('input').click());
  await view.act(() => styleRows()[1].querySelector('input').click());
  await view.act(() => styleRows()[0].querySelector('input').click());
  await view.act(() => view.createButton().click());
  assert.deepEqual(view.created, [{ name: 'Div', asProp: [], folder: '', moveStyles: ['centered'] }]);
  await view.unmount();
});

test('Move styles: says it is looking until the list arrives, and an unreadable list moves nothing', async () => {
  let arrive;
  const slow = await mount('Div', () => new Promise((resolve) => (arrive = resolve)));
  assert.match(styleSection().textContent, /Looking for this markup’s styles/);
  await slow.act(() => slow.createButton().click());
  assert.deepEqual(slow.created[0].moveStyles, [], 'creating before the list arrives moves no CSS');
  await slow.act(() => arrive(CANDIDATES));
  await slow.unmount();
  const broken = await mount('Div', async () => {
    throw new Error('disk');
  });
  await broken.act(() => undefined);
  assert.match(styleSection().textContent, /Couldn’t read the styles, so none will move/);
  await broken.act(() => broken.createButton().click());
  assert.deepEqual(broken.created[0].moveStyles, []);
  await broken.unmount();
});

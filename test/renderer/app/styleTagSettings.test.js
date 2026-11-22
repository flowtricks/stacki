// Goal: Settings > New style locations (src/app/settings/StyleTagSettings.tsx) has one section per scope, a
// page and a component. Each shows a dropdown (the shared custom Dropdown, never a native select) that picks
// "Create a style tag" or one of the project's stylesheets by path. With a style tag chosen, the section shows
// one code block holding the whole new tag, `<style ...>` … `</style>`, the scope's default content; a
// project that only holds the older `newStyleTag` section shows it in BOTH scopes (migration). A valid change
// is saved to `.stacki/styles.json` as the `newStyleLocations` section, keeping the rest of the file, with the
// page's tag mirrored into the older `newStyleTag`; attributes that do not parse turn the block red and are not
// saved; the tag stays a style tag (delimiters cannot be edited); a chosen stylesheet that is not in the project
// shows a warning chip and keeps the tag editor beneath it; a role that may not edit sees everything read-only;
// a failed write is shown.
// Method: the real component bundled for jsdom over an in-memory styles file behind a stubbed `window.avb`
// (projectMetadata / writeProjectMetadata / listStyleFiles, the calls the bridges make). Edits are dispatched
// into the real CodeMirror view as the person's own (a user event), so the lock sees them as it sees typing;
// the dropdown is driven through its real trigger and rows. Nothing sleeps: the editor's 600 ms save debounce runs on a mocked
// clock the test ticks, and everything else is waited for on the state it produces (waitFor), so a slow runner changes no outcome.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

// The editor's save debounce (SAVE_DELAY_MS in StyleTagSettings.tsx): the tick that fires it.
const SAVE_DELAY_MS = 600;
// Task turns that let a started write finish; a setImmediate is a task boundary, not a pause, and the write chain only awaits stubs.
const DRAIN_TURNS = 3;
const drain = async () => {
  for (let turn = 0; turn < DRAIN_TURNS; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
// Runs `action` (the person's edits) with the clock mocked, fires the save debounce it started, then lets the write finish. Why a mocked
// clock: the debounce is a product timer, so the test ticks it instead of sleeping past it, and a "nothing was saved" check needs no guess.
const editAndSave = async (action) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    action();
    mock.timers.tick(SAVE_DELAY_MS);
  } finally {
    mock.timers.reset();
  }
  await drain();
};
const writesReach = (view, count) => waitFor({ what: `${count} saved write(s)`, read: () => view.writes.length, until: (length) => length >= count });
let environment;

async function load() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'style-tag-settings.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { StyleTagSettings } from './src/app/settings/StyleTagSettings'\nexport { EditorView } from 'codemirror'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

async function mount({ source, editable = true, failWrite = false, stylesheets = ['src/styles/global.css', 'src/styles/components.css'] }) {
  const { dom, React, createRoot, StyleTagSettings } = await load();
  const file = { source };
  const writes = [];
  let listed = false;
  dom.window.avb = {
    // The editor's variable chips subscribe to stylesheet changes; nothing changes here.
    onCssChanged: () => () => undefined,
    listStyleFiles: async () => ((listed = true), { files: stylesheets.map((rel) => ({ rel, name: rel.split('/').pop(), path: `/p/${rel}`, size: 10 })) }),
    projectMetadata: async () => ({ ok: true, value: { source: file.source } }),
    writeProjectMetadata: async (input) => {
      if (failWrite) {
        return { ok: false, error: { code: 'write-failed', message: 'disk full' } };
      }
      writes.push(input.write.source);
      file.source = input.write.source;
      return { ok: true, value: { source: input.write.source } };
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const track = (save) => save;
  root.render(React.createElement(StyleTagSettings, { projectPath: '/p', editable, track }));
  // Ready once the section and its editor are drawn and the stylesheet list has arrived.
  await waitFor({
    what: 'the settings drawn with their stylesheet list',
    read: () => listed && container.querySelector('[data-scope="component"] .cm-editor, [data-scope="component"] .dd-trigger') !== null,
    until: (ready) => ready,
  });
  await drain();
  return { container, writes, file, unmount: () => (root.unmount(), container.remove()) };
}

// The scope's section, its CodeMirror view, and what it holds.
const sectionOf = (container, scope) => {
  const section = container.querySelector(`[data-scope="${scope}"]`);
  assert.ok(section, `the ${scope} section is shown`);
  return section;
};
const viewOf = (container, scope = 'page') => {
  const editor = sectionOf(container, scope).querySelector('.cm-editor');
  assert.ok(editor, 'the block is a code editor');
  const view = environment.EditorView.findFromDOM(editor);
  assert.ok(view, 'the editor has a view');
  return view;
};
const shown = (container, scope = 'page') => viewOf(container, scope).state.doc.toString();
// A person's edit: insert `insert` over `from`..`to`, as typing (or pasting) does.
const type = (container, from, to, insert, userEvent = 'input.type', scope = 'page') => {
  viewOf(container, scope).dispatch({ changes: { from, to, insert }, userEvent });
};
// Opens a scope's dropdown and picks the row whose text includes `label`.
const pick = async (view, scope, label) => {
  const writesBefore = view.writes.length;
  sectionOf(view.container, scope).querySelector('.dd-trigger').click();
  await openRows();
  const row = [...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes(label));
  assert.ok(row, `the dropdown lists ${label}`);
  row.click();
  await writesReach(view, writesBefore + 1);
};
// Waits for the opened dropdown to draw its rows.
const openRows = () => waitFor({ what: 'the dropdown rows', read: () => document.querySelectorAll('.dd-option').length, until: (count) => count > 0 });
const lastWrite = (view) => JSON.parse(view.writes[view.writes.length - 1]);

const PAGE_TAG = { version: 2, attributes: 'is:global' };

test('a project without the section shows <style is:global> in both scopes, and reading writes nothing', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'] }) });
  context.after(view.unmount);
  assert.equal(shown(view.container, 'page'), '<style is:global>\n</style>');
  assert.equal(shown(view.container, 'component'), '<style is:global>\n</style>');
  assert.deepEqual(view.writes, []);
  assert.deepEqual(
    [...view.container.querySelectorAll('h4')].map((heading) => heading.textContent),
    ['Styles created in a page', 'Styles created in a component'],
  );
  assert.equal(view.container.querySelectorAll('select').length, 0, 'never a native select');
  assert.equal(sectionOf(view.container, 'page').querySelector('.dd-trigger').textContent, 'Create a style tag');
  // A code field, not a code window: no line numbers, no fold gutter, no active-line band.
  assert.ok(!view.container.querySelector('.cm-gutters'), 'no gutter');
  assert.ok(!view.container.querySelector('.cm-activeLine'), 'no active-line band');
});

test('the older single template is shown in both scopes, as it was chosen', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [], newStyleTag: { version: 1, isGlobal: false, content: '@layer a {}' } }) });
  context.after(view.unmount);
  assert.equal(shown(view.container, 'page'), '<style>\n@layer a {}\n</style>');
  assert.equal(shown(view.container, 'component'), '<style>\n@layer a {}\n</style>');
  assert.deepEqual(view.writes, [], 'migrating on read writes nothing');
});

test('content typed between the tags saves into its scope only, keeping the rest of the file', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'], lockedStylesheets: ['src/styles/vendor/'] }) });
  context.after(view.unmount);
  const at = shown(view.container, 'component').indexOf('</style>');
  await editAndSave(() => type(view.container, at, at, '@layer components {\n}\n', 'input.type', 'component'));
  await writesReach(view, 1);
  assert.equal(view.writes.length, 1, 'one save after the debounce');
  const written = lastWrite(view);
  assert.deepEqual(written.keep, ['is-*']);
  assert.deepEqual(written.lockedStylesheets, ['src/styles/vendor/']);
  assert.deepEqual(written.newStyleLocations.component, { use: 'tag', tag: { ...PAGE_TAG, content: '@layer components {\n}' } });
  assert.deepEqual(written.newStyleLocations.page, { use: 'tag', tag: PAGE_TAG }, 'the page scope keeps its own default');
  assert.deepEqual(written.newStyleTag, PAGE_TAG, 'the page tag is mirrored for an older Stacki');
  assert.equal(shown(view.container, 'page'), '<style is:global>\n</style>');
  // Typed indented, as the editor indents inside the tag: saved without the shared indentation.
  const inner = shown(view.container, 'component').indexOf('@layer');
  const end = shown(view.container, 'component').indexOf('</style>');
  await editAndSave(() => type(view.container, inner, end, '  @layer base {\n    .a {}\n  }\n', 'input.type', 'component'));
  await writesReach(view, 2);
  assert.equal(lastWrite(view).newStyleLocations.component.tag.content, '@layer base {\n  .a {}\n}');
});

test('attributes are edited on the opening tag; ones that do not parse turn the block red and are not saved', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const end = shown(view.container).indexOf('>');
  await editAndSave(() => type(view.container, end, end, ' lang=scss'));
  const editor = sectionOf(view.container, 'page').querySelector('.style-tags-editor');
  assert.ok(editor.hasAttribute('data-invalid'), 'the block is marked');
  assert.equal(sectionOf(view.container, 'page').querySelector('.style-tags-invalid').textContent, 'Invalid');
  assert.deepEqual(view.writes, [], 'nothing invalid is saved');
  // Fixed: the quotes go in, the mark goes, and it saves.
  const fixed = shown(view.container).indexOf('scss');
  await editAndSave(() => type(view.container, fixed, fixed + 4, '"scss"'));
  await writesReach(view, 1);
  assert.ok(!editor.hasAttribute('data-invalid'));
  assert.equal(view.writes.length, 1);
  assert.equal(lastWrite(view).newStyleLocations.page.tag.attributes, 'is:global lang="scss"');
  // Taking is:global off saves a plain <style>.
  const global = shown(view.container).indexOf(' is:global');
  await editAndSave(() => type(view.container, global, global + ' is:global'.length, '', 'delete.backward'));
  await writesReach(view, 2);
  assert.equal(shown(view.container), '<style lang="scss">\n</style>');
  assert.equal(lastWrite(view).newStyleLocations.page.tag.attributes, 'lang="scss"');
});

test('the tag stays a style tag: its delimiters cannot be typed over, deleted or renamed', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const before = shown(view.container);
  const close = before.indexOf('</style>');
  const end = before.indexOf('>');
  const refused = [
    ['typing inside <style', 3, 3, 'x'],
    ['typing before <style', 0, 0, 'x'],
    ['renaming the tag', 1, 6, 'div'],
    ['deleting the opening >', end, end + 1, ''],
    ['typing inside </style>', close + 2, close + 2, 'x'],
    ['deleting </style>', close, close + 8, ''],
    ['typing after </style>', before.length, before.length, '<p>'],
    ['a > in the attributes', end, end, ' a>'],
    ['another tag in the content', close, close, '<style>x</style><style>'],
    ['selecting everything and typing', 0, before.length, 'x'],
  ];
  await editAndSave(() => {
    for (const [what, from, to, insert] of refused) {
      type(view.container, from, to, insert);
      assert.equal(shown(view.container), before, what);
    }
  });
  assert.deepEqual(view.writes, [], 'nothing refused is saved');
});

test('a whole style tag pasted into the content becomes its content', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const close = shown(view.container).indexOf('</style>');
  await editAndSave(() => type(view.container, close, close, '<style lang="scss">\n@layer base {}\n</style>', 'input.paste'));
  assert.equal(shown(view.container), '<style is:global>\n@layer base {}</style>');
  await writesReach(view, 1);
  assert.equal(lastWrite(view).newStyleLocations.page.tag.content, '@layer base {}');
});

test('the dropdown lists the style tag first, then the project stylesheets by path, and a pick is saved for its scope', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  sectionOf(view.container, 'component').querySelector('.dd-trigger').click();
  await openRows();
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option')].map((option) => option.textContent.replace(/\s+$/, '')),
    ['Create a style tag', 'src/styles/global.css', 'src/styles/components.css'],
  );
  document.querySelectorAll('.dd-option')[2].click();
  await writesReach(view, 1);
  assert.equal(sectionOf(view.container, 'component').querySelector('.dd-trigger').textContent, 'src/styles/components.css');
  assert.ok(!sectionOf(view.container, 'component').querySelector('.cm-editor'), 'a file needs no tag editor');
  assert.ok(sectionOf(view.container, 'page').querySelector('.cm-editor'), 'the page scope is unchanged');
  assert.deepEqual(lastWrite(view).newStyleLocations.component, { use: 'file', file: 'src/styles/components.css', tag: PAGE_TAG });
  assert.equal(lastWrite(view).newStyleLocations.page.use, 'tag');
  // Back to a style tag: the tag default is still there, and the file is gone from the section.
  await pick(view, 'component', 'Create a style tag');
  assert.ok(sectionOf(view.container, 'component').querySelector('.cm-editor'));
  assert.deepEqual(lastWrite(view).newStyleLocations.component, { use: 'tag', tag: PAGE_TAG });
});

test('a chosen stylesheet that is not in the project shows a warning chip, keeps the tag editor, and is never rewritten by reading', async (context) => {
  const source = JSON.stringify({
    version: 1,
    keep: [],
    newStyleLocations: { version: 1, page: { use: 'file', file: 'src/styles/gone.css', tag: PAGE_TAG }, component: { use: 'tag', tag: PAGE_TAG } },
  });
  const view = await mount({ source });
  context.after(view.unmount);
  const chip = sectionOf(view.container, 'page').querySelector('.style-tags-chip');
  assert.ok(chip, 'the warning chip is shown');
  assert.match(chip.textContent, /src\/styles\/gone\.css was not found/);
  assert.ok(!sectionOf(view.container, 'component').querySelector('.style-tags-chip'), 'only the scope with the missing file warns');
  assert.ok(sectionOf(view.container, 'page').querySelector('.cm-editor'), 'the tag that is used meanwhile stays editable');
  assert.deepEqual(view.writes, []);
  // Picking an existing file clears the chip.
  await pick(view, 'page', 'src/styles/global.css');
  assert.ok(!sectionOf(view.container, 'page').querySelector('.style-tags-chip'));
});

test('a role that may not edit sees everything read-only, and a failed write is shown', async (context) => {
  const readOnly = await mount({ source: JSON.stringify({ version: 1, keep: [] }), editable: false });
  context.after(readOnly.unmount);
  assert.ok(readOnly.container.querySelector('.style-tags-editor').hasAttribute('data-readonly'));
  assert.ok(sectionOf(readOnly.container, 'page').querySelector('.dd-trigger').disabled);
  readOnly.unmount();
  const failing = await mount({ source: JSON.stringify({ version: 1, keep: [] }), failWrite: true });
  context.after(failing.unmount);
  const at = shown(failing.container).indexOf('</style>');
  await editAndSave(() => type(failing.container, at, at, '@layer a {}\n'));
  const alert = await waitFor({
    what: 'the failed write shown',
    read: () => failing.container.querySelector('[role="alert"]'),
    until: (node) => node !== null,
  });
  assert.match(alert.textContent, /disk full/);
});

test('every row and the closed trigger carry an icon; a short list has no search', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const trigger = sectionOf(view.container, 'page').querySelector('.dd-trigger');
  assert.ok(trigger.querySelector('.dd-icon svg'), 'the closed dropdown shows the icon of its value');
  trigger.click();
  await openRows();
  const rows = [...document.querySelectorAll('.dd-option')];
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((row) => row.querySelector('.dd-icon svg')),
    'icon at the start of each row',
  );
  assert.ok(!document.querySelector('.dd-search'), 'three options need no search');
});

test('a long list is searchable: substring, any case, accents ignored, and an empty result says so', async (context) => {
  const stylesheets = [
    'src/styles/base.css',
    'src/styles/global.css',
    'src/styles/patterns.css',
    'src/styles/utilities.css',
    'src/styles/café.css',
    'src/styles/Print.css',
  ];
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }), stylesheets });
  context.after(view.unmount);
  sectionOf(view.container, 'page').querySelector('.dd-trigger').click();
  await openRows();
  const search = document.querySelector('.dd-search');
  assert.ok(search, 'seven options show the search');
  const labels = () => [...document.querySelectorAll('.dd-option')].map((row) => row.textContent);
  // Types the query and waits until the list shows its outcome, as the person would see it.
  const setQuery = async (value, shows) => {
    const setter = Object.getOwnPropertyDescriptor(environment.dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, value);
    search.dispatchEvent(new environment.dom.window.Event('input', { bubbles: true }));
    await waitFor({ what: `the list filtered by ${value}`, read: () => labels(), until: shows });
  };
  const stylesheetsOnly = (list) => list.filter((label) => label.includes('.css'));
  await setQuery('CAFE', (list) => stylesheetsOnly(list).length === 1);
  assert.deepEqual(
    labels().filter((label) => label.includes('.css')),
    ['src/styles/café.css'],
  );
  assert.ok(
    labels().some((label) => label.includes('Create a style tag')),
    'the way back to a tag is never filtered away',
  );
  await setQuery('PRINT', (list) => stylesheetsOnly(list).length === 1 && list.some((label) => label.includes('Print')));
  assert.deepEqual(
    labels().filter((label) => label.includes('.css')),
    ['src/styles/Print.css'],
  );
  await setQuery('zzz', (list) => stylesheetsOnly(list).length === 0);
  assert.deepEqual(
    labels().filter((label) => label.includes('.css')),
    [],
  );
  assert.ok(document.querySelector('.dd-empty'), 'No matches');
});

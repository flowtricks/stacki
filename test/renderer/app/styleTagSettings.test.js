// Goal: Settings > Style tags > New style tags (src/app/settings/StyleTagSettings.tsx) is one code block
// holding the whole new tag: it shows the project's `newStyleTag` setting as `<style ...>` … `</style>` (a
// project without the section shows `<style is:global>`, Stacki's default), saves a valid change of the
// attributes or the content to `.stacki/styles.json` as version 2 keeping the rest of the file, refuses
// to save attributes that do not parse (the block turns red with one word), keeps the tag a style tag
// (typing over `<style`, the opening `>` or `</style>` is refused; a pasted whole tag becomes its content),
// is read-only for a role that may not edit breakpoints' settings, and shows a failed write.
// Method: the real component bundled for jsdom over an in-memory styles file behind a stubbed `window.avb`
// (projectMetadata / writeProjectMetadata, the calls the bridge makes). Edits are dispatched into the real
// CodeMirror view as the person's own (a user event), so the lock sees them as it sees typing.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function mount({ source, editable = true, failWrite = false }) {
  const { dom, React, createRoot, StyleTagSettings } = await load();
  const file = { source };
  const writes = [];
  dom.window.avb = {
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
  await wait(400);
  return { container, writes, file, unmount: () => (root.unmount(), container.remove()) };
}

// The block's CodeMirror view, and what it holds.
const viewOf = (container) => {
  const editor = container.querySelector('.cm-editor');
  assert.ok(editor, 'the block is a code editor');
  const view = environment.EditorView.findFromDOM(editor);
  assert.ok(view, 'the editor has a view');
  return view;
};
const shown = (container) => viewOf(container).state.doc.toString();
// A person's edit: insert `insert` over `from`..`to`, as typing (or pasting) does.
const type = (container, from, to, insert, userEvent = 'input.type') => {
  viewOf(container).dispatch({ changes: { from, to, insert }, userEvent });
};

test('a project without the section shows <style is:global>, and reading writes nothing', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'] }) });
  context.after(view.unmount);
  assert.equal(shown(view.container), '<style is:global>\n</style>');
  assert.deepEqual(view.writes, []);
  assert.ok(!view.container.querySelector('[role="switch"]'), 'no separate switch: the block says it');
  assert.equal(view.container.querySelector('h4').textContent, 'New style tags');
  // A code field, not a code window: no line numbers, no fold gutter, no active-line band.
  assert.ok(!view.container.querySelector('.cm-gutters'), 'no gutter');
  assert.ok(!view.container.querySelector('.cm-activeLine'), 'no active-line band');
});

test('an older plain <style> choice is shown as it was chosen', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [], newStyleTag: { version: 1, isGlobal: false, content: '@layer a {}' } }) });
  context.after(view.unmount);
  assert.equal(shown(view.container), '<style>\n@layer a {}\n</style>');
});

test('content typed between the tags is saved as version 2, keeping the rest of the file', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'], lockedStylesheets: ['src/styles/vendor/'] }) });
  context.after(view.unmount);
  const at = shown(view.container).indexOf('</style>');
  type(view.container, at, at, '@layer components {\n}\n');
  await wait(900);
  assert.equal(view.writes.length, 1, 'one save after the pause');
  const written = JSON.parse(view.writes[0]);
  assert.deepEqual(written.keep, ['is-*']);
  assert.deepEqual(written.lockedStylesheets, ['src/styles/vendor/']);
  assert.deepEqual(written.newStyleTag, { version: 2, attributes: 'is:global', content: '@layer components {\n}' });
  // Typed indented, as the editor indents inside the tag: saved without the shared indentation.
  const inner = shown(view.container).indexOf('@layer');
  const end = shown(view.container).indexOf('</style>');
  type(view.container, inner, end, '  @layer base {\n    .a {}\n  }\n');
  await wait(900);
  assert.equal(JSON.parse(view.writes[view.writes.length - 1]).newStyleTag.content, '@layer base {\n  .a {}\n}');
});

test('attributes are edited on the opening tag; ones that do not parse turn the block red and are not saved', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const end = shown(view.container).indexOf('>');
  type(view.container, end, end, ' lang=scss');
  await wait(900);
  const editor = view.container.querySelector('.style-tags-editor');
  assert.ok(editor.hasAttribute('data-invalid'), 'the block is marked');
  assert.equal(view.container.querySelector('.style-tags-invalid').textContent, 'Invalid');
  assert.deepEqual(view.writes, [], 'nothing invalid is saved');
  // Fixed: the quotes go in, the mark goes, and it saves.
  const fixed = shown(view.container).indexOf('scss');
  type(view.container, fixed, fixed + 4, '"scss"');
  await wait(900);
  assert.ok(!editor.hasAttribute('data-invalid'));
  assert.equal(view.writes.length, 1);
  assert.equal(JSON.parse(view.writes[0]).newStyleTag.attributes, 'is:global lang="scss"');
  // Taking is:global off saves a plain <style>.
  const global = shown(view.container).indexOf(' is:global');
  type(view.container, global, global + ' is:global'.length, '', 'delete.backward');
  await wait(900);
  assert.equal(shown(view.container), '<style lang="scss">\n</style>');
  assert.equal(JSON.parse(view.writes[view.writes.length - 1]).newStyleTag.attributes, 'lang="scss"');
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
  for (const [what, from, to, insert] of refused) {
    type(view.container, from, to, insert);
    assert.equal(shown(view.container), before, what);
  }
  await wait(900);
  assert.deepEqual(view.writes, [], 'nothing refused is saved');
});

test('a whole style tag pasted into the content becomes its content', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }) });
  context.after(view.unmount);
  const close = shown(view.container).indexOf('</style>');
  type(view.container, close, close, '<style lang="scss">\n@layer base {}\n</style>', 'input.paste');
  assert.equal(shown(view.container), '<style is:global>\n@layer base {}</style>');
  await wait(900);
  assert.equal(JSON.parse(view.writes[0]).newStyleTag.content, '@layer base {}');
});

test('a role that may not edit sees the block read-only, and a failed write is shown', async (context) => {
  const readOnly = await mount({ source: JSON.stringify({ version: 1, keep: [] }), editable: false });
  context.after(readOnly.unmount);
  assert.ok(readOnly.container.querySelector('.style-tags-editor').hasAttribute('data-readonly'));
  readOnly.unmount();
  const failing = await mount({ source: JSON.stringify({ version: 1, keep: [] }), failWrite: true });
  context.after(failing.unmount);
  const at = shown(failing.container).indexOf('</style>');
  type(failing.container, at, at, '@layer a {}\n');
  await wait(900);
  assert.match(failing.container.querySelector('[role="alert"]').textContent, /disk full/);
});

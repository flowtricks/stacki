// Goal: the converted ContentView still loads, edits, validates, and saves a
// schema-backed entry. Methodology: bundle the real TSX panel, mount it in
// jsdom behind a scripted preload bridge, edit one field, and inspect payloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const settle = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('ContentView renders parsed entries and saves only the edited field', async () => {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'content-view-render.bundle.cjs');
  buildSync({
    entryPoints: [repoPath('src/features/content/ContentView.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@uiw/react-codemirror', '@codemirror/*', 'codemirror'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  installDOM(dom);
  const writes = [];
  const validations = [];
  dom.window.avb = scriptedBridge(writes, validations);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const ContentView = require(output).default;
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ContentView, {
        project: { path: '/project' },
        name: 'posts',
        hidden: false,
      }),
    );
    await settle(20);
  });
  assert.match(container.textContent, /Hello/);
  const titleField = [...container.querySelectorAll('.cms-field')].find((node) => /^Title/.test(node.querySelector('label')?.textContent ?? ''));
  const input = titleField?.querySelector('input');
  assert.ok(input);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Welcome');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(500);
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].edits, [{ path: ['title'], value: 'Welcome' }]);
  assert.equal(validations.length, 1);
  assert.deepEqual(validations[0].data, { title: 'Welcome', summary: 'Keep me' });
  await act(async () => root.unmount());
  delete require.cache[output];
  fs.rmSync(output, { force: true });
});

function installDOM(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.IS_REACT_ACT_ENVIRONMENT = true;
}

function scriptedBridge(writes, validations) {
  return {
    contentEntries: async () => ({
      entries: [
        {
          id: 'hello',
          file: 'src/content/posts/hello.json',
          format: 'json',
          locator: [],
          data: { title: 'Hello', summary: 'Keep me' },
          title: 'Hello',
        },
      ],
      readOnly: false,
      collection: {
        name: 'posts',
        editable: true,
        schema: {
          type: 'object',
          properties: { title: { type: 'string' }, summary: { type: 'string' } },
          required: ['title', 'summary'],
        },
      },
    }),
    validateContentEntry: async (payload) => {
      validations.push(payload);
      return { issues: [] };
    },
    writeContentEntry: async (payload) => {
      writes.push(payload);
      return { ok: true, changed: true };
    },
    onCmsChanged: () => () => {},
  };
}

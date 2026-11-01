// Drive collection settings through its real controls and confirmation host.
// Verify nested schema paths, retaining a typed name while changing field kind,
// and reporting disk failures without announcing a successful deletion.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/cms-settings.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export {default as Settings} from './src/features/cms/CmsSettings';
      export {ConfirmHost} from './src/ui/ConfirmDialog';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { Settings, ConfirmHost } = require(output);
const click = (element) => act(async () => element.click());
const button = (label) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const type = (input, text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const collection = { rel: 'data/site.json', label: 'Site', single: false };

function fixture(overrides = {}) {
  const operations = [];
  const errors = [];
  const root = createRoot(document.getElementById('root'));
  const props = {
    collection,
    items: [{ title: 'Old', group: { inner: 'Nested' } }],
    declared: {},
    saved: false,
    project: { path: '/project' },
    showToast: (message) => errors.push(message),
    onAddField: (...args) => operations.push(['add', ...args]),
    onRenameField: (...args) => {
      operations.push(['rename', ...args]);
      return false;
    },
    onRemoveField: (...args) => operations.push(['remove', ...args]),
    onReorderFields() {},
    ...overrides,
  };
  return {
    operations,
    errors,
    root,
    mount: () => act(async () => root.render(React.createElement(React.Fragment, {}, React.createElement(Settings, props), React.createElement(ConfirmHost)))),
  };
}

test('nested schema editing preserves paths and the new field name', async () => {
  const state = fixture();
  try {
    await state.mount();
    await click(document.querySelector('[title="Show its fields"]'));
    const name = document.querySelector('.cms-schema-nested input');
    await act(async () => name.focus());
    await type(name, 'New inner');
    await act(async () => name.blur());
    assert.deepEqual(state.operations[0], ['rename', ['group'], 'inner', 'newInner']);
    assert.equal(name.value, 'Inner', 'rejected rename restores the original label');
    await click(document.querySelector('.cms-schema-nested .cms-add'));
    await click([...document.querySelectorAll('.cms-type-tile')].find((entry) => entry.querySelector('.cms-type-name').textContent === 'Text'));
    await type(document.querySelector('.cms-type-modal input'), 'Hero title');
    await click(document.querySelector('[title="Back to field types"]'));
    await click([...document.querySelectorAll('.cms-type-tile')].find((entry) => entry.querySelector('.cms-type-name').textContent === 'Long text'));
    assert.equal(document.querySelector('.cms-type-modal input').value, 'Hero title');
    await click(document.querySelector('.cms-type-modal .primary'));
    assert.deepEqual(state.operations[1], ['add', ['group'], 'heroTitle', 'longtext']);
    assert.ok(document.querySelector('.cms-type-modal') === null);
  } finally {
    await act(async () => state.root.unmount());
  }
});

test('collection settings omit code helpers while retaining content fields', async () => {
  const helper = { __expr: '(entry) => entry.summary || entry.subtitle' };
  const state = fixture({
    items: [
      {
        title: 'Retreats',
        description: helper,
        landingImages: { cover: 'hero.avif', selectImage: helper },
      },
    ],
  });
  try {
    await state.mount();
    const labels = () => [...document.querySelectorAll('.cms-schema-name')].map((input) => input.value);
    assert.deepEqual(labels(), ['Title', 'Landing images']);
    await click(document.querySelector('[title="Show its fields"]'));
    assert.deepEqual(labels(), ['Title', 'Landing images', 'Cover']);
  } finally {
    await act(async () => state.root.unmount());
  }
});

test('collection deletion handles usage and write failures before reporting success', async () => {
  let removed = 0;
  let writes = 0;
  const state = fixture({ onDeleted: () => removed++ });
  window.avb = {
    cmsUsage: async () => {
      throw new Error('usage unavailable');
    },
    deleteCms: async () => {
      writes++;
      throw new Error('read only');
    },
  };
  try {
    await state.mount();
    await click(button('Delete Site'));
    assert.deepEqual(state.errors, ['usage unavailable']);
    assert.equal(writes, 0);
    window.avb.cmsUsage = async () => ({ files: ['pages/index.astro'] });
    await click(button('Delete Site'));
    assert.match(document.body.textContent, /1 page uses it/);
    await click(button('Delete collection'));
    assert.deepEqual(state.errors, ['usage unavailable', 'read only']);
    assert.equal(removed, 0);
    window.avb.deleteCms = async () => ({ ok: true, rewritten: ['pages/index.astro'] });
    await click(button('Delete Site'));
    await click(button('Delete collection'));
    assert.equal(removed, 1);
  } finally {
    await act(async () => state.root.unmount());
  }
});

test.after(() => dom.window.close());

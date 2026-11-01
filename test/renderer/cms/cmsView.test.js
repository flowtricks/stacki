// Mount the full CMS view against deferred IPC to verify that changing the
// selected file flushes edits to their original owner. Old reads and completed
// saves must not replace the newly selected collection or leak subscriptions.
const { toastMessages } = require('../../helpers/toastCapture');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/cms-view.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/CmsView.tsx')],
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const View = require(output).default;
const type = (input, text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

function fixture() {
  const root = createRoot(document.getElementById('root'));
  const reads = [];
  const writes = [];
  const commands = [];
  const errors = [];
  const listeners = new Set();
  window.avb = {
    readCms: (payload) => new Promise((resolve, reject) => reads.push({ payload, resolve, reject })),
    cmsMeta: async () => ({ meta: {} }),
    writeCms: (payload) => new Promise((resolve) => writes.push({ payload, resolve })),
    onCmsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const show = (rel) =>
    act(async () =>
      root.render(
        React.createElement(View, {
          project: { path: '/project' },
          rel,
          onRecordUndo: (command) => commands.push(command),
          showToast: (message) => errors.push(message),
        }),
      ),
    );
  return { root, reads, writes, commands, errors, listeners, show };
}

test('switching CMS files flushes the old edit to the old file', async () => {
  const state = fixture();
  try {
    await state.show('a.json');
    await act(async () => state.reads[0].resolve({ data: [{ title: 'First' }] }));
    await type(document.querySelector('.cms-field input'), 'Changed first');
    await state.show('b.json');
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.writes[0].payload, {
      projectPath: '/project',
      rel: 'a.json',
      data: [{ title: 'Changed first' }],
    });
    assert.equal(state.listeners.size, 1);
    await act(async () => state.reads[1].resolve({ data: [{ title: 'Second' }] }));
    await act(async () => state.writes[0].resolve({ ok: true }));
    assert.equal(document.querySelector('.cms-field input').value, 'Second');
    assert.equal(state.commands.length, 1);
    assert.equal(state.commands[0].coalesceKey, 'cms:a.json');
    assert.deepEqual(state.errors, []);
    await type(document.querySelector('.cms-field input'), 'Changed second');
    await act(async () => state.root.unmount());
    assert.equal(state.listeners.size, 0);
    assert.equal(state.writes[1].payload.rel, 'b.json');
    await act(async () => state.writes[1].resolve({ ok: true }));
    assert.equal(state.commands.length, 2);
  } finally {
    await act(async () => state.root.unmount());
  }
});

test('the content form hides helpers and preserves them when saving copy', async () => {
  const state = fixture();
  const helper = { __expr: '(entry) => entry.summary || entry.subtitle' };
  try {
    await state.show('data/site.ts#*general');
    await act(async () => state.reads[0].resolve({ data: { title: 'Retreats', description: helper } }));
    assert.equal(document.querySelectorAll('.cms-field').length, 1);
    assert.match(document.querySelector('.cms-field').textContent, /Title/);
    assert.doesNotMatch(document.querySelector('.cms-detail-body').textContent, /Description/);
    await type(document.querySelector('.cms-field input'), 'New retreats');
    await act(async () => state.root.unmount());
    assert.deepEqual(state.writes[0].payload.data, {
      title: 'New retreats',
      description: helper,
    });
    await act(async () => state.writes[0].resolve({ ok: true }));
  } finally {
    await act(async () => state.root.unmount());
  }
});

test('obsolete reads cannot replace the selected ' + 'collection and unreadable files cannot be edited', async () => {
  const state = fixture();
  try {
    await state.show('a.json');
    await state.show('b.json');
    await act(async () => state.reads[1].resolve({ data: [{ title: 'Second' }] }));
    await act(async () => state.reads[0].resolve({ data: [{ title: 'Obsolete' }] }));
    assert.equal(document.querySelector('.cms-field input').value, 'Second');
    await act(async () => {
      for (const listener of state.listeners) {
        listener();
      }
    });
    await act(async () => state.reads[2].reject(new Error('cannot read')));
    assert.match(toastMessages(), /cannot read/);
    assert.ok(document.querySelector('[title="New item"]') === null);
    assert.ok(document.querySelector('.cms-items .primary') === null);
    assert.equal(state.writes.length, 0);
  } finally {
    await act(async () => state.root.unmount());
  }
});

test.after(() => dom.window.close());

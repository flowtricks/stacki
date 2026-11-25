// Goal: saved editor text updates Git status without a reload or a polling delay.
// Method: render the real Git hook, defer IPC reads, and drive save checksums through
// typing, failed saves, successful saves and undo while keeping the project mounted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

const originalChecksum = 'a'.repeat(64);
const editedChecksum = 'b'.repeat(64);
const cleanRepository = {
  isRepo: true,
  branch: 'main',
  branches: ['main'],
  dirty: false,
  ahead: 1,
  parked: [],
};

function fixture(context) {
  const output = repoPath('node_modules/.stacki-test/git-refresh.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/app/state/appNavigation.ts')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  delete require.cache[output];
  const { useGitInfo } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  window.avb = {
    gitInfo: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const project = { path: '/project', name: 'Project' };
  const projectRef = { current: project };
  const errors = [];
  const lifecycle = { showToast: (message) => errors.push(message) };
  let latest;
  function Harness({ save }) {
    const [info, setGitInfo] = React.useState(undefined);
    useGitInfo({ project, projectRef, refreshKey: 0, setGitInfo, pageState: { save } }, lifecycle);
    latest = info;
    return undefined;
  }
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return {
    requests,
    errors,
    read: () => latest,
    show: (save) => act(async () => root.render(React.createElement(Harness, { save }))),
  };
}

test('Saved text and undo refresh Git; unsaved and failed edits do not', async (context) => {
  const view = fixture(context);
  await view.show({ tag: 'clean', checksum: originalChecksum });
  assert.equal(view.requests.length, 1);
  await act(async () => view.requests[0].resolve(cleanRepository));
  assert.equal(view.read().dirty, false);
  for (const tag of ['dirty', 'saving', 'dirty', 'saving']) {
    await view.show({ tag, baseChecksum: originalChecksum });
    assert.equal(view.requests.length, 1, 'No Git read before the save reaches disk');
  }
  await view.show({ tag: 'clean', checksum: editedChecksum });
  assert.equal(view.requests.length, 2, 'Saving refreshes without a timer or filesystem event');
  await act(async () => view.requests[1].resolve({ ...cleanRepository, dirty: true }));
  assert.equal(view.read().dirty, true);
  await view.show({ tag: 'clean', checksum: originalChecksum });
  assert.equal(view.requests.length, 3, 'Undo refreshes when the original bytes reach disk');
  await act(async () => view.requests[2].resolve(cleanRepository));
  assert.equal(view.read().dirty, false);
});

test('Saves during a Git read coalesce into a fresh read after it finishes', async (context) => {
  const view = fixture(context);
  await view.show({ tag: 'clean', checksum: originalChecksum });
  await view.show({ tag: 'dirty', baseChecksum: editedChecksum });
  await view.show({ tag: 'clean', checksum: 'c'.repeat(64) });
  assert.equal(view.requests.length, 1, 'At most one Git read runs at a time');
  await act(async () => view.requests[0].resolve(cleanRepository));
  assert.equal(view.requests.length, 2, 'A save during the read cannot lose its refresh');
  await act(async () => view.requests[1].resolve({ ...cleanRepository, dirty: true }));
  assert.equal(view.read().dirty, true);
  assert.equal(view.requests.length, 2, 'A burst queues at most one follow-up');
});

test('A failed Git read reports its error and the next saved edit retries', async (context) => {
  const view = fixture(context);
  await view.show({ tag: 'clean', checksum: originalChecksum });
  await act(async () => view.requests[0].reject(new Error('Repository unavailable')));
  assert.deepEqual(view.errors, ['Repository unavailable']);
  await view.show({ tag: 'clean', checksum: editedChecksum });
  await act(async () => view.requests[1].resolve({ ...cleanRepository, dirty: true }));
  assert.equal(view.read().dirty, true);
});

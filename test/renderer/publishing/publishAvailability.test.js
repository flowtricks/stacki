// Goal: fresh edits invalidate current status, and late checks cannot undo that invalidation.
// Method: drive the Desktop hook with deferred IPC, save transitions, and filesystem events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

function fixture(context) {
  const output = repoPath('node_modules/.stacki-test/publish-availability.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/app/shell/usePublishAvailability.ts')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });
  delete require.cache[output];
  const { usePublishAvailability } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  let changed;
  window.avb = {
    publishAvailability: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    onFsChanged: (callback) => {
      changed = callback;
      return () => {};
    },
    onAssetsChanged: () => () => {},
    onCmsChanged: () => () => {},
    onCssChanged: () => () => {},
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let latest;
  function Harness({ saveState, repository, settingsRevision }) {
    latest = usePublishAvailability('/project', 'idle', saveState, repository, settingsRevision);
    return undefined;
  }
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return {
    requests,
    read: () => latest,
    change: () => act(async () => changed({ files: ['/project/src/page.astro'] })),
    show: (saveState, repository, settingsRevision) => act(async () => root.render(React.createElement(Harness, { saveState, repository, settingsRevision }))),
  };
}

const current = { github: 'current', hosting: 'current' };
const pending = { github: 'pending', hosting: 'pending' };
const unknown = { github: 'unknown', hosting: 'unknown' };

test('Unsaved edits re-enable actions; saves refresh status', async (context) => {
  const view = fixture(context);
  await view.show({ tag: 'clean', checksum: 'a'.repeat(64) });
  await act(async () => view.requests[0].resolve(current));
  assert.deepEqual(view.read(), current);
  await view.show({ tag: 'dirty', baseChecksum: 'a'.repeat(64) });
  assert.deepEqual(view.read(), pending);
  await act(async () => view.requests[1].resolve(current));
  assert.deepEqual(view.read(), pending);
  await view.show({ tag: 'clean', checksum: 'b'.repeat(64) });
  await act(async () => view.requests[2].resolve(pending));
  assert.deepEqual(view.read(), pending);
});

test('Committing refreshes the dropdown count without waiting for polling', async (context) => {
  const view = fixture(context);
  const save = { tag: 'clean', checksum: 'a'.repeat(64) };
  await view.show(save, { isRepo: false });
  await act(async () => view.requests[0].resolve(current));
  await view.show(save, { isRepo: true, ahead: 2 });
  assert.equal(view.requests.length, 2);
  const result = {
    ...pending,
    githubPush: { commits: 2, repositoryUrl: 'https://github.com/example/website' },
  };
  await act(async () => view.requests[1].resolve(result));
  assert.deepEqual(view.read(), result);
});

test('File events supersede stale checks; failures stay unknown', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  await view.change();
  await act(async () => view.requests[0].resolve(current));
  assert.deepEqual(view.read(), unknown);
  assert.equal(view.requests.length, 2);
  await act(async () => view.requests[1].resolve(pending));
  assert.deepEqual(view.read(), pending);
  await view.change();
  await act(async () => view.requests[2].reject(new Error('Offline')));
  assert.deepEqual(view.read(), unknown);
});

test('Closing publish settings invalidates stale hosting status immediately', async (context) => {
  const view = fixture(context);
  await view.show(undefined, undefined, 0);
  await act(async () => view.requests[0].resolve({ github: 'current', hosting: 'unconfigured' }));
  await view.show(undefined, undefined, 1);
  assert.deepEqual(view.read(), unknown);
  assert.equal(view.requests.length, 2);
  await act(async () => view.requests[1].resolve({ github: 'current', hosting: 'pending' }));
  assert.equal(view.read().hosting, 'pending');
});

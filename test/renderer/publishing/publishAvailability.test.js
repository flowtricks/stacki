// Goal: the Publish button never draws "changes to publish" until a check has confirmed them, however
// many edits, saves, file events and window returns arrive while a check is under way.
// Method: drive the Desktop hook with deferred IPC, save transitions and filesystem events, and record
// every rendered frame, so a flash that lasts one render still fails the test.
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
  const frames = [];
  function Harness({ saveState, repository, settingsRevision }) {
    latest = usePublishAvailability('/project', 'idle', saveState, repository, settingsRevision);
    frames.push(latest);
    return undefined;
  }
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return {
    requests,
    frames,
    read: () => latest,
    change: (...files) => act(async () => changed({ files: files.length === 0 ? ['/project/src/page.astro'] : files })),
    settle: (milliseconds) => act(async () => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    show: (saveState, repository, settingsRevision) => act(async () => root.render(React.createElement(Harness, { saveState, repository, settingsRevision }))),
  };
}

const current = { github: 'current', hosting: 'current' };
const pending = { github: 'pending', hosting: 'pending' };
const unknown = { github: 'unknown', hosting: 'unknown' };

const QUIET = 260;
const CONFIRM = 300;

test('Unsaved edits keep the last confirmed state; the save confirms the change', async (context) => {
  const view = fixture(context);
  await view.show({ tag: 'clean', checksum: 'a'.repeat(64) });
  await act(async () => view.requests[0].resolve(current));
  assert.deepEqual(view.read(), current);
  await view.show({ tag: 'dirty', baseChecksum: 'a'.repeat(64) });
  assert.deepEqual(view.read(), current, 'A draft is not a confirmed change');
  await act(async () => view.requests[1].resolve(current));
  assert.deepEqual(view.read(), current);
  await view.show({ tag: 'clean', checksum: 'b'.repeat(64) });
  await act(async () => view.requests[2].resolve(pending));
  assert.deepEqual(view.read(), current, 'The first answer that differs waits for a confirming check');
  await view.settle(CONFIRM);
  await act(async () => view.requests[3].resolve(pending));
  assert.deepEqual(view.read(), pending);
  assert.deepEqual(view.frames.filter((frame) => frame.github === 'pending').length > 0, true);
});

test('A burst of file events costs one check and never draws a pending frame', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  await act(async () => view.requests[0].resolve(current));
  for (let event = 0; event < 8; event += 1) {
    await view.change(`/project/src/page${event}.astro`);
  }
  await view.settle(QUIET);
  assert.equal(view.requests.length, 2, 'Eight events, one check');
  await act(async () => view.requests[1].resolve(current));
  assert.deepEqual(
    view.frames.filter((frame) => frame.github !== 'current' || frame.hosting !== 'current').slice(1),
    [],
    'After the first confirmed answer every frame is current',
  );
});

test('Generated and scratch files never ask for a check', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  await act(async () => view.requests[0].resolve(current));
  await view.change('/project/.stacki/preview/page.html', '/project/node_modules/.vite/deps/a.js', '/project/src/.DS_Store', '/project/src/page.astro~');
  await view.settle(QUIET);
  assert.equal(view.requests.length, 1);
  await view.change('/project/.stacki/preview/page.html', '/project/src/page.astro');
  await view.settle(QUIET);
  assert.equal(view.requests.length, 2, 'One real file in the batch is enough');
  await act(async () => view.requests[1].resolve(current));
});

test('A change that reverts before the confirming check is never drawn', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  await act(async () => view.requests[0].resolve(current));
  await view.change();
  await view.settle(QUIET);
  await act(async () => view.requests[1].resolve(pending));
  assert.deepEqual(view.read(), current);
  await view.settle(CONFIRM);
  assert.equal(view.requests.length, 3, 'A held answer asks for exactly one confirming check');
  await act(async () => view.requests[2].resolve(current));
  assert.deepEqual(view.read(), current);
  assert.equal(
    view.frames.some((frame) => frame.github === 'pending'),
    false,
    'No frame ever drew the transient change',
  );
});

test('The first check answers neutral, and failures keep the last confirmed state', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  assert.deepEqual(view.read(), unknown, 'Before any answer nothing is claimed');
  await act(async () => view.requests[0].resolve(current));
  await view.change();
  await view.settle(QUIET);
  await act(async () => view.requests[1].reject(new Error('Offline')));
  assert.deepEqual(view.read(), current);
  await view.change();
  await view.settle(QUIET);
  await act(async () => view.requests[2].resolve(unknown));
  assert.deepEqual(view.read(), current, 'A check that could not judge a destination keeps its last state');
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
  // A first answer that turns "nothing to publish" into "changes" is confirmed once before it is drawn.
  await view.settle(CONFIRM);
  await act(async () => view.requests[2].resolve(result));
  assert.deepEqual(view.read(), result);
});

test('File events supersede stale checks without ever showing them', async (context) => {
  const view = fixture(context);
  await view.show(undefined);
  await view.change();
  await act(async () => view.requests[0].resolve(current));
  assert.deepEqual(view.read(), current);
  await view.settle(QUIET);
  assert.equal(view.requests.length, 2);
  await view.change();
  await act(async () => view.requests[1].resolve(pending));
  assert.deepEqual(view.read(), current, 'A result that a newer event supersedes is dropped');
});

test('Closing publish settings invalidates stale hosting status immediately', async (context) => {
  const view = fixture(context);
  await view.show(undefined, undefined, 0);
  await act(async () => view.requests[0].resolve({ github: 'current', hosting: 'unconfigured' }));
  await view.show(undefined, undefined, 1);
  assert.equal(view.read().hosting, 'unconfigured', 'The old answer stays until the new check replies');
  assert.equal(view.requests.length, 2);
  await act(async () => view.requests[1].resolve({ github: 'current', hosting: 'pending' }));
  assert.equal(view.read().hosting, 'pending');
});

// Goal: incoming commits update in the background without stale branch results or request bursts.
// Methodology: mount the real hook with deferred IPC and controlled intervals; drive focus,
// remote changes, HEAD changes, offline recovery and unmount without network or wall-clock waits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

const repository = {
  isRepo: true,
  branch: 'main',
  remote: 'https://github.com/example/project.git',
  head: 'a'.repeat(40),
  branches: ['main'],
  dirty: false,
  ahead: 0,
  parked: [],
};

function fixture(context) {
  const output = repoPath('node_modules/.stacki-test/git-incoming.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/git/useGitIncoming.ts')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });
  delete require.cache[output];
  const { useGitIncoming } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  window.setInterval = (callback, delay) => {
    assert.equal(delay, 30000);
    timers.set(++nextTimer, callback);
    return nextTimer;
  };
  window.clearInterval = (id) => timers.delete(id);
  window.avb = {
    gitIncoming: (payload) =>
      new Promise((resolve, reject) => {
        requests.push({ payload, resolve, reject });
      }),
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let latest;
  function Harness({ projectPath, info }) {
    latest = useGitIncoming(projectPath, info);
    return undefined;
  }
  context.after(async () => {
    await act(async () => root.unmount());
    assert.equal(timers.size, 0);
    dom.window.close();
  });
  return {
    requests,
    timers,
    read: () => latest,
    show: (info = repository, projectPath = '/project') => act(async () => root.render(React.createElement(Harness, { projectPath, info }))),
    tick: () =>
      act(async () => {
        for (const callback of timers.values()) {
          callback();
        }
      }),
    focus: () => act(async () => window.dispatchEvent(new window.Event('focus'))),
  };
}

test('Poll and focus detect commits and recover from offline', async (context) => {
  const view = fixture(context);
  await view.show();
  assert.deepEqual(view.read(), { kind: 'checking' });
  assert.deepEqual(view.requests[0].payload, { projectPath: '/project', branch: 'main' });
  await act(async () => view.requests[0].resolve(0));
  assert.deepEqual(view.read(), { kind: 'ready', commits: 0 });
  await view.tick();
  assert.deepEqual(view.read(), { kind: 'ready', commits: 0 });
  await act(async () => view.requests[1].resolve(2));
  assert.deepEqual(view.read(), { kind: 'ready', commits: 2 });
  await view.focus();
  await act(async () => view.requests[2].reject(new Error('Offline')));
  assert.deepEqual(view.read(), { kind: 'unavailable', message: 'Offline' });
  await view.tick();
  await act(async () => view.requests[3].resolve(0));
  assert.deepEqual(view.read(), { kind: 'ready', commits: 0 });
});

test('Focus bursts coalesce; status reads skip network checks', async (context) => {
  const view = fixture(context);
  await view.show();
  await view.show({ ...repository, dirty: true });
  assert.equal(view.requests.length, 1);
  await view.focus();
  await view.focus();
  await view.tick();
  assert.equal(view.requests.length, 1);
  await act(async () => view.requests[0].resolve(1));
  assert.equal(view.requests.length, 2);
  assert.deepEqual(view.read(), { kind: 'ready', commits: 1 });
  await act(async () => view.requests[1].resolve(2));
  assert.deepEqual(view.read(), { kind: 'ready', commits: 2 });
});

test('Repository changes discard old counts and late results', async (context) => {
  const view = fixture(context);
  await view.show();
  await act(async () => view.requests[0].resolve(2));
  for (const change of [
    { ...repository, branch: 'topic' },
    { ...repository, head: 'b'.repeat(40) },
    { ...repository, remote: 'https://github.com/example/other.git' },
  ]) {
    await view.show(change);
    assert.deepEqual(view.read(), { kind: 'checking' });
    await act(async () => view.requests.at(-1).resolve(0));
    assert.deepEqual(view.read(), { kind: 'ready', commits: 0 });
  }
  await view.tick();
  const previous = view.requests.at(-1);
  await view.show(repository, '/other-project');
  await act(async () => previous.resolve(9));
  assert.deepEqual(view.read(), { kind: 'checking' });
  await act(async () => view.requests.at(-1).resolve(0));
  assert.deepEqual(view.read(), { kind: 'ready', commits: 0 });
  await view.show({ isRepo: false });
  const count = view.requests.length;
  await view.focus();
  await view.tick();
  assert.equal(view.requests.length, count);
});

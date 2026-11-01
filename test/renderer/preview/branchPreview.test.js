// Goal: branch checkouts never run under the preview watcher, or leave a dead iframe.
// Method: mount the real lifecycle hooks with deferred IPC to prove stop/checkout/start
// ordering, failure recovery, project-change isolation, and offline state after startup failure.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

test('branch preview pauses before checkout and restarts after success or failure', async () => {
  const directory = repoPath('node_modules/.stacki-test/branch-preview');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'hooks.cjs');
  esbuild.buildSync({
    stdin: {
      contents: `export {useBranchPreview, usePreviewStart} from ` + `${sourceSpecifier('src/app/state/appLifecycle.ts')};`,
      resolveDir: repoPath('src'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useBranchPreview, usePreviewStart } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const events = [];
  let finishStop;
  let stopError;
  let startError;
  window.avb = {
    stopDevServer: () =>
      new Promise((resolve, reject) => {
        events.push('stop');
        finishStop = () => (stopError ? reject(new Error(stopError)) : resolve({ ok: true }));
      }),
    startDevServer: async () => {
      events.push('start');
      if (startError) {
        throw new Error(startError);
      }
      return { url: 'http://localhost:4321' };
    },
  };
  const state = {
    projectRef: { current: { path: '/project', name: 'Project' } },
    devLogRef: { current: '' },
    setDevStatus: (value) => events.push(`status:${value}`),
    setDevUrl: (value) => events.push(value ? 'url:ready' : 'url:empty'),
    setDevLog() {},
    setBusy() {},
    setDevDiag() {},
    setTrailingSlash() {},
  };
  let changeBranch;
  function Harness() {
    const { startPreview } = usePreviewStart(state, { showToast() {} }, { diagnose() {} });
    changeBranch = useBranchPreview(state, startPreview);
    return undefined;
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const work = async () => {
      events.push('checkout');
      return 'main';
    };
    const pending = changeBranch(work);
    assert.deepEqual(events, ['url:empty', 'status:starting', 'stop']);
    finishStop();
    assert.equal(await pending, 'main');
    assert.deepEqual(
      events.filter((event) => ['stop', 'checkout', 'start'].includes(event)),
      ['stop', 'checkout', 'start'],
    );
    assert.equal(events.at(-1), 'status:on');
    events.length = 0;
    const failed = changeBranch(async () => {
      throw new Error('Checkout failed');
    });
    finishStop();
    await assert.rejects(failed, /Checkout failed/);
    assert.ok(events.includes('start'));
    stopError = 'Stop failed';
    events.length = 0;
    const refused = changeBranch(work);
    finishStop();
    await assert.rejects(refused, /Stop failed/);
    assert.equal(events.includes('checkout'), false);
    stopError = undefined;
    startError = 'Astro configuration failed';
    events.length = 0;
    const offline = changeBranch(work);
    finishStop();
    assert.equal(await offline, 'main');
    assert.equal(events.at(-2), 'status:off');
    assert.equal(events.at(-1), 'url:empty');
    assert.equal(state.devLogRef.current, startError);
    startError = undefined;
    events.length = 0;
    const closed = changeBranch(work);
    state.projectRef.current = undefined;
    finishStop();
    await closed;
    assert.equal(events.includes('start'), false);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

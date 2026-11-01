// Goal: adding Studio starts installation with one click and advances only on success.
// Method: mount the real setup UI with deferred IPC replies to exercise progress,
// failure and retry, and opening projects that already contain a Studio folder.
const { toastMessages } = require('../../helpers/toastCapture');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/studio-setup.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/studioSetup/StudioSetup.tsx')],
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const StudioSetup = require(output).default;
const click = (element) => act(async () => element.click());
const button = (label) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const currentStep = () => document.querySelector('[aria-current="step"]').textContent;
const missing = { kind: 'missing', desktopVersion: '0.1.48' };

async function fixture(status = missing, previewURL = 'http://localhost:4327/some-page?query=yes') {
  const calls = [];
  const replies = [];
  const listeners = new Set();
  const opened = [];
  window.avb = {
    studioStatus: async () => status,
    openExternal: async (url) => {
      opened.push(url);
      return { ok: true };
    },
    onStudioProgress: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    installStudio: (options) => {
      calls.push(options);
      return new Promise((resolve) => replies.push(resolve));
    },
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(StudioSetup, {
        projectPath: '/project',
        previewURL,
      }),
    );
  });
  return {
    calls,
    listeners,
    opened,
    progress: (value) =>
      act(async () => {
        for (const listener of listeners) {
          listener({ projectPath: '/project', requestId: calls.at(-1).requestId, ...value });
        }
      }),
    finish: (reply) => act(async () => replies.shift()(reply)),
    close: () => act(async () => root.unmount()),
  };
}

test('Add to project installs once, shows progress, and advances to local preview', async () => {
  const state = await fixture();
  try {
    assert.equal(state.calls.length, 0);
    await click(button('Add to project'));
    assert.equal(state.calls[0].projectPath, '/project');
    assert.equal(state.calls[0].source, 'published');
    assert.match(state.calls[0].requestId, /^[a-zA-Z0-9-]+$/);
    assert.equal(document.querySelector('dialog').open, true);
    assert.equal(button('Add Studio to project'), undefined);
    assert.equal(button('Choose release file…'), undefined);
    assert.match(document.querySelector('dialog').textContent, /Preparing Studio release/);
    assert.match(currentStep(), /Install/);
    assert.equal(button('Close').disabled, true);
    await click(button('Add to project'));
    assert.equal(state.calls.length, 1);
    await state.finish({ kind: 'installed', version: '0.1.48' });
    assert.match(currentStep(), /Local preview/);
    assert.equal(button('Open Studio').disabled, false);
    assert.equal(state.opened.length, 0);
    await click(button('Open Studio'));
    assert.deepEqual(state.opened, ['http://localhost:4327/studio']);
    assert.equal(document.querySelector('[aria-label="Launch command"]').value, 'npm run dev -- --config node_modules/.avb/astro.config.mjs');
    assert.equal(button('Close').disabled, false);
    await click(button('Back'));
    assert.match(currentStep(), /Install/);
    assert.match(document.querySelector('dialog').textContent, /Studio is installed/);
    assert.equal(state.calls.length, 1);
  } finally {
    await state.close();
  }
});

test('failed installation stays on Install and supports an explicit retry', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    await state.finish({ kind: 'error', message: 'Download failed' });
    assert.match(currentStep(), /Install/);
    assert.match(toastMessages(), /Download failed/);
    assert.equal(button('Close').disabled, false);
    await click(button('Retry installation'));
    assert.equal(state.calls.length, 2);
    assert.ok(document.querySelector('[role="alert"]') === null);
    await state.finish({ kind: 'installed', version: '0.1.48' });
    assert.match(currentStep(), /Local preview/);
  } finally {
    await state.close();
  }
});

test('managing an installed project starts at local preview without reinstalling', async () => {
  const state = await fixture({ ...missing, kind: 'installed', version: '0.1.48' });
  try {
    await click(button('Manage Stacki Studio'));
    assert.match(currentStep(), /Local preview/);
    assert.equal(state.opened.length, 0);
    await click(button('Open Studio'));
    assert.deepEqual(state.opened, ['http://localhost:4327/studio']);
    assert.equal(state.calls.length, 0);
  } finally {
    await state.close();
  }
});

test('reviewing a blocked project never attempts installation', async () => {
  const state = await fixture({ ...missing, kind: 'blocked', message: 'Existing studio folder' });
  try {
    await click(button('Review Studio setup'));
    assert.match(toastMessages(), /Existing studio folder/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.opened.length, 0);
    assert.equal(button('Retry installation'), undefined);
  } finally {
    await state.close();
  }
});

test('live stages and output stay scoped to the attempt and survive failure', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    assert.equal(state.listeners.size, 1);
    assert.equal(document.querySelector('progress').value, 0);
    await state.progress({ stage: 'dependencies', output: '$ npm ci\nDownloading packages\n' });
    assert.equal(document.querySelector('progress').value, 2);
    assert.match(document.querySelector('[role="log"]').textContent, /Downloading packages/);
    await state.progress({ projectPath: '/other', stage: 'build', output: 'Wrong project' });
    await state.progress({ requestId: 'older-attempt', stage: 'build', output: 'Old request' });
    assert.equal(document.querySelector('progress').value, 2);
    await state.progress({
      stage: 'check',
      output: '<script>literal output</script>\nCheck failed',
    });
    assert.ok(document.querySelector('[role="log"] script') === null);
    await state.finish({ kind: 'error', message: 'Check failed' });
    assert.equal(state.listeners.size, 0);
    assert.match(document.querySelector('[role="log"]').textContent, /Check failed/);
    assert.match(document.querySelector('.studio-install-progress-heading').textContent, /Stopped/);
    const oldRequest = state.calls[0].requestId;
    await click(button('Retry installation'));
    assert.notEqual(state.calls[1].requestId, oldRequest);
    assert.equal(document.querySelector('progress').value, 0);
    assert.doesNotMatch(document.querySelector('[role="log"]').textContent, /Check failed/);
    await state.progress({ requestId: oldRequest, stage: 'complete', output: 'Old completion' });
    assert.equal(document.querySelector('progress').value, 0);
    await state.finish({ kind: 'installed', version: '0.1.48' });
    assert.equal(state.listeners.size, 0);
    assert.match(currentStep(), /Local preview/);
  } finally {
    await state.close();
  }
});

test('unmount removes the progress listener while installation is pending', async () => {
  const state = await fixture();
  await click(button('Add to project'));
  assert.equal(state.listeners.size, 1);
  await state.close();
  assert.equal(state.listeners.size, 0);
  await state.finish({ kind: 'installed', version: '0.1.48' });
});

test('Studio cannot open missing, malformed or remote website preview addresses', async () => {
  for (const url of ['', 'invalid', 'https://example.com', 'http://user:secret@localhost:4321']) {
    const state = await fixture({ kind: 'installed', desktopVersion: '0.1.48', version: '0.1.48' }, url);
    try {
      await click(button('Manage Stacki Studio'));
      assert.equal(button('Open Studio').disabled, true);
      assert.equal(state.opened.length, 0);
    } finally {
      await state.close();
    }
  }
});

test.after(() => dom.window.close());

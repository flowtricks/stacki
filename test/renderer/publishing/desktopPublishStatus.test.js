// Goal: publishing progress is honest, completion is clear, and partial failures remain visible.
// Method: render the real dialog with each backend state and inspect progress and result controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

function fixture(context, component = 'DesktopPublishStatus') {
  const output = repoPath('node_modules/.stacki-test/desktop-publish-status.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/app/shell/DesktopPublishButton.tsx')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  delete require.cache[output];
  const Component = require(output)[component];
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return (input) => act(async () => root.render(React.createElement(Component, component === 'DesktopPublishStatus' ? { state: input, close() {} } : input)));
}

function desktopFixture(context, dirty) {
  const render = fixture(context, 'DesktopPublishButton');
  const starts = [];
  const order = [];
  window.avb = {
    projectMetadata: async () => ({ ok: true, value: {} }),
    publishAvailability: async () => ({ github: 'pending', hosting: 'unconfigured' }),
    publishState: async () => ({ kind: 'idle' }),
    publishStart: async (input) => {
      starts.push(input);
      return { kind: 'done', github: true, hosting: false };
    },
    gitInfo: async () => {
      order.push('checked');
      return {
        isRepo: true,
        branch: 'main',
        branches: ['main'],
        dirty,
        ahead: 1,
        parked: [],
        remote: 'https://github.com/example/website.git',
      };
    },
    onFsChanged: () => () => {},
    onAssetsChanged: () => () => {},
    onCmsChanged: () => () => {},
    onCssChanged: () => () => {},
  };
  return {
    starts,
    order,
    show: () =>
      render({
        projectPath: '/project',
        flushSave: async () => order.push('saved'),
        refresh: async () => {},
        saveState: undefined,
        repository: undefined,
      }),
  };
}

async function clickGitHubPush() {
  await act(async () => document.querySelector('[aria-label="More publish options"]').click());
  await act(async () => document.querySelector('.stacki-publish-github > button').click());
}

test('Dirty changes prompt after saving and use the entered message', async (context) => {
  const view = desktopFixture(context, true);
  await view.show();
  await clickGitHubPush();
  assert.deepEqual(view.order, ['saved', 'checked']);
  assert.equal(view.starts.length, 0);
  assert.equal(document.querySelector('.publish-commit-message button[type="submit"]').disabled, true);
  const input = document.querySelector('.publish-commit-message textarea');
  await act(async () => {
    input.value = 'Update homepage heading';
    require('react-dom/test-utils').Simulate.change(input);
  });
  await act(async () => document.querySelector('.publish-commit-message form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(view.starts, [
    {
      projectPath: '/project',
      target: 'github',
      commitMessage: 'Update homepage heading',
    },
  ]);
});

test('Already committed changes push directly without prompting', async (context) => {
  const view = desktopFixture(context, false);
  await view.show();
  await clickGitHubPush();
  assert.deepEqual(view.starts, [{ projectPath: '/project', target: 'github' }]);
  assert.equal(document.querySelector('.publish-commit-message') === null, true);
});

test('Cancelling the message prompt never starts publishing', async (context) => {
  const view = desktopFixture(context, true);
  await view.show();
  await clickGitHubPush();
  await act(async () => document.querySelector('.publish-commit-message button[type="button"]').click());
  assert.equal(view.starts.length, 0);
});

test('Progress follows completed stages and cannot be dismissed mid-publish', async (context) => {
  const show = fixture(context);
  await show({ kind: 'running', step: 'Preparing publish…' });
  assert.equal(document.querySelector('progress').hasAttribute('value'), false);
  assert.equal(document.querySelector('dialog').open, true);
  assert.equal(document.querySelector('.modal-footer button') === null, true);
  await show({ kind: 'running', step: 'Building website', progress: { completed: 1, total: 4 } });
  assert.equal(document.querySelector('progress').value, 1);
  assert.equal(document.querySelector('progress').max, 4);
  assert.match(document.body.textContent, /Step 2 of 4/);
  const cancel = new window.Event('cancel', { cancelable: true });
  document.querySelector('dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(document.querySelector('dialog').open, true);
});

test('Success shows only completed destinations and a Done action', async (context) => {
  const show = fixture(context);
  await show({ kind: 'done', github: true, hosting: false });
  assert.match(document.body.textContent, /Published successfully/);
  assert.match(document.body.textContent, /Changes pushed to GitHub/);
  assert.doesNotMatch(document.body.textContent, /Hosting deployment completed/);
  assert.equal(document.querySelector('.modal-footer button').textContent, 'Done');
  assert.equal(document.querySelector('progress') === null, true);
  await show({ kind: 'done', github: true, hosting: true });
  assert.match(document.body.textContent, /Hosting deployment completed/);
});

test('A failed deployment retains the confirmed GitHub result', async (context) => {
  const show = fixture(context);
  await show({ kind: 'failed', message: 'Hosting is unavailable', github: true, hosting: false });
  assert.match(document.body.textContent, /Publish needs attention/);
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Hosting is unavailable');
  assert.match(document.body.textContent, /Changes pushed to GitHub/);
  assert.doesNotMatch(document.body.textContent, /Hosting deployment completed/);
  assert.equal(document.querySelector('.modal-footer button').textContent, 'Close');
});

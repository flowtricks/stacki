// Goal: publishing progress is honest, completion is clear, and partial failures remain visible,
// and Desktop and Studio show it through one shared popup that renders their steps the same way.
// Method: render the shared popup with each backend state and inspect progress and result controls;
// render Studio's job stages through Studio's mapping into that same popup and compare the markup;
// read both hosts' sources to pin them to the shared component.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

// Studio imports shared code from its assembled vendor tree; in this repository that tree is the root.
const vendoredStacki = {
  name: 'vendored-stacki',
  setup(build) {
    build.onResolve({ filter: /\/vendor\/stacki\// }, (args) => ({
      path: path.join(ROOT, args.path.slice(args.path.indexOf('/vendor/stacki/') + '/vendor/stacki/'.length)) + '.ts',
    }));
  },
};

async function bundle(entry, name) {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    entryPoints: [repoPath(entry)],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [vendoredStacki],
  });
  delete require.cache[output];
  return require(output);
}

async function fixture(context, component = 'PublishStatus') {
  const Component =
    component === 'PublishStatus'
      ? (await bundle('src/features/publishing/PublishStatus.tsx', 'publish-status')).PublishStatus
      : (await bundle('src/app/shell/DesktopPublishButton.tsx', 'desktop-publish-button'))[component];
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
  return (input) =>
    act(async () =>
      root.render(React.createElement(Component, component === 'PublishStatus' ? { close() {}, ...('state' in input ? input : { state: input }) } : input)),
    );
}

async function desktopFixture(context, dirty) {
  const render = await fixture(context, 'DesktopPublishButton');
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
  const view = await desktopFixture(context, true);
  await view.show();
  await clickGitHubPush();
  // The branch gate reads git first (nothing is saved or sent before the person knows which branch this is), then the publish saves and checks as before.
  assert.deepEqual(view.order, ['checked', 'saved', 'checked']);
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
  const view = await desktopFixture(context, false);
  await view.show();
  await clickGitHubPush();
  assert.deepEqual(view.starts, [{ projectPath: '/project', target: 'github' }]);
  assert.equal(document.querySelector('.publish-commit-message') === null, true);
});

test('Cancelling the message prompt never starts publishing', async (context) => {
  const view = await desktopFixture(context, true);
  await view.show();
  await clickGitHubPush();
  await act(async () => document.querySelector('.publish-commit-message button[type="button"]').click());
  assert.equal(view.starts.length, 0);
});

test('Progress follows completed stages and cannot be dismissed mid-publish', async (context) => {
  const show = await fixture(context);
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
  const show = await fixture(context);
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
  const show = await fixture(context);
  await show({ kind: 'failed', message: 'Hosting is unavailable', github: true, hosting: false });
  assert.match(document.body.textContent, /Publish needs attention/);
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Hosting is unavailable');
  assert.match(document.body.textContent, /Changes pushed to GitHub/);
  assert.doesNotMatch(document.body.textContent, /Hosting deployment completed/);
  assert.equal(document.querySelector('.modal-footer button').textContent, 'Close');
});

// Studio's job stages, in the order a deployed run reports them, through Studio's own mapping.
const STUDIO_RUN = [
  { kind: 'building', id: 'run' },
  { kind: 'building', id: 'run', stage: 'preparing' },
  { kind: 'building', id: 'run', stage: 'building' },
  { kind: 'building', id: 'run', stage: 'committing' },
  { kind: 'building', id: 'run', stage: 'cleanup', deployment: 'pending' },
  { kind: 'building', id: 'run', stage: 'deploying', deployment: 'pending' },
];

function studioView() {
  return bundle('studio/src/features/publishing/publishStatusView.ts', 'studio-publish-status-view');
}

test('Studio stages render as the same popup steps Desktop shows', async (context) => {
  const show = await fixture(context);
  const { publishStatusView } = await studioView();
  const { parseDesktopPublishState } = await bundle('shared/properties/publishState.ts', 'publish-state');
  const steps = [];
  for (const stage of STUDIO_RUN) {
    const view = publishStatusView(stage, 'running');
    // The popup accepts only the shared contract; Studio's mapping must produce it exactly.
    assert.deepEqual(parseDesktopPublishState(view.state), view.state);
    await show({ state: view.state, runningNote: 'Publishing continues if you switch tabs.' });
    assert.equal(document.querySelector('dialog').open, true);
    assert.equal(document.querySelector('.modal-footer button') === null, true, 'A running publish cannot be dismissed');
    steps.push([document.querySelector('[role="status"]').textContent, document.querySelector('small').textContent]);
  }
  assert.deepEqual(steps, [
    ['Preparing publish…', 'Preparing your project'],
    ['Preparing files…', 'Step 1 of 4'],
    ['Building website…', 'Step 2 of 4'],
    ['Saving to GitHub…', 'Step 3 of 4'],
    ['Cleaning up storage…', 'Step 4 of 5'],
    ['Deploying live website…', 'Step 5 of 5'],
  ]);
});

test('Studio results use the shared success, review and failure states', async (context) => {
  const show = await fixture(context);
  const { publishStatusView, PUBLISH_INTERRUPTED_MESSAGE } = await studioView();
  const live = publishStatusView({ kind: 'committed', id: 'run', sha: 'a', url: 'https://example.com', deployment: 'live' }, 'running');
  assert.deepEqual(live, { state: { kind: 'done', github: true, hosting: true } });
  await show(live);
  assert.match(document.body.textContent, /Published successfully/);
  assert.match(document.body.textContent, /Hosting deployment completed/);
  assert.equal(document.querySelector('.publish-status-note') === null, true);
  const pending = publishStatusView({ kind: 'committed', id: 'run', sha: 'a', url: 'https://example.com', deployment: 'pending' }, 'running');
  assert.deepEqual(pending.state, { kind: 'done', github: true, hosting: false });
  await show(pending);
  assert.match(document.querySelector('.publish-status-note').textContent, /Deployment is still unconfirmed/);
  const hostingOnly = publishStatusView(
    { kind: 'committed', id: 'run', sha: 'a', url: 'https://example.com', github: 'skipped', deployment: 'live' },
    'running',
  );
  assert.deepEqual(hostingOnly.state, { kind: 'done', github: false, hosting: true });
  const failed = publishStatusView({ kind: 'failed', id: 'run', message: 'Build failed' }, 'interrupted');
  await show(failed);
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Build failed');
  assert.equal(document.querySelector('.modal-footer button').textContent, 'Close');
  assert.deepEqual(publishStatusView(undefined, 'interrupted').state.message, PUBLISH_INTERRUPTED_MESSAGE);
  assert.equal(publishStatusView({ kind: 'failed', id: 'run', message: 'Build failed' }, 'running').state.kind, 'failed');
  const review = publishStatusView({ kind: 'review-open', id: 'run', sha: 'a'.repeat(40), branch: 'b', url: 'https://github.com/o/r/pull/1' }, 'running');
  assert.deepEqual(review.state, { kind: 'review-open', sha: 'a'.repeat(40), branch: 'b', url: 'https://github.com/o/r/pull/1' });
  await show(review);
  assert.match(document.body.textContent, /Ready for review/);
});

test('A host note and running footer have their own place in the popup', async (context) => {
  const show = await fixture(context);
  await show({ state: { kind: 'running', step: 'Saving to GitHub…', progress: { completed: 2, total: 4 } }, note: 'Demo note.', runningNote: 'Keep going.' });
  assert.equal(document.querySelector('.publish-status-body .publish-status-note').textContent, 'Demo note.');
  assert.equal(document.querySelector('.modal-footer > span').textContent, 'Keep going.');
  await show({ kind: 'running', step: 'Saving to GitHub…' });
  assert.equal(document.querySelector('.modal-footer > span').textContent, 'Keep Stacki open until publishing finishes.');
});

test('Desktop and Studio both render the shared publish popup and nothing else', () => {
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
  const desktop = read('src/app/shell/DesktopPublishButton.tsx');
  assert.equal(desktop.includes("import { PublishStatus } from '../../features/publishing/PublishStatus';"), true, 'Desktop imports the shared popup');
  assert.doesNotMatch(desktop, /<Popup className="modal [^"]*status/, 'Desktop keeps no second status dialog');
  const studio = read('studio/src/features/publishing/PublishButton.tsx');
  assert.equal(
    studio.includes("import { PublishStatus } from '../../../vendor/stacki/src/features/publishing/PublishStatus';"),
    true,
    'Studio imports the vendored shared popup',
  );
  assert.equal(fs.existsSync(repoPath('studio/src/features/publishing/PublishProgress.tsx')), false, 'Studio keeps no separate progress panel');
  const vendored = JSON.parse(read('studio/scripts/shared-source.json')).files;
  assert.equal(vendored.includes('src/features/publishing/PublishStatus.tsx'), true, 'Studio vendors the shared popup');
  assert.doesNotMatch(read('studio/src/features/publishing/publish.css'), /studio-publish-progress|border:/, 'Studio keeps no dropdown panel styles');
  assert.doesNotMatch(
    read('src/features/publishing/publishing.css')
      .match(/\.publish-status[\s\S]*?\n\}/g)
      .join('\n'),
    /border:(?!\s*(?:0|none);)/,
    'The popup uses fills, not borders',
  );
});

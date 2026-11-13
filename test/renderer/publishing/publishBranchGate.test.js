// Goal: publishing from a branch nobody chose is never silent. The branch chip beside Publish shows the current branch (quiet on
// the default one, an amber warning anywhere else, "Detached HEAD" when on no branch, nothing without a repository or commits),
// and every way of starting a publish asks first when the branch is not the default one: nothing is saved, committed or sent
// until the person answers. "Don't warn again" is remembered per project and branch; "Switch first" refuses safely when the
// project has uncommitted changes and sends the branch name to git as data.
// Methodology: the real DesktopPublishButton and BranchIndicator bundled for jsdom, with a scripted window.avb whose git:info
// answer can change between clicks (a branch switched outside the app) and which records each checkout and publish start.
// Negative space: the default branch, no repository, no commits, a stale cached branch, a dirty tree, a refused checkout, a
// silenced branch in another project, and Cancel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

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
  });
  delete require.cache[output];
  return require(output);
}

const repository = (overrides) => ({
  isRepo: true,
  branch: 'main',
  branches: ['main', 'feature/x'],
  dirty: false,
  ahead: 0,
  parked: [],
  head: 'abc123',
  trunk: 'main',
  defaultBranch: 'main',
  remote: 'https://github.com/example/website.git',
  ...overrides,
});

function installDom(context) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    delete global.localStorage;
  });
  return root;
}

async function publishing(context, { info, projectPath = '/project', checkout, repositoryProp, metadata } = {}) {
  const { DesktopPublishButton } = await bundle('src/app/shell/DesktopPublishButton.tsx', 'branch-gate-publish');
  const root = installDom(context);
  const state = { info };
  const starts = [];
  const checkouts = [];
  const order = [];
  const reloads = [];
  window.avb = {
    projectMetadata: async () => ({ ok: true, value: metadata ?? {} }),
    publishAvailability: async () => ({ github: 'pending', hosting: 'unconfigured' }),
    publishState: async () => ({ kind: 'idle' }),
    publishStart: async (input) => {
      starts.push(input);
      return { kind: 'done', github: true, hosting: false };
    },
    gitInfo: async () => state.info,
    gitCheckout: async (payload) => {
      checkouts.push(payload);
      const outcome = checkout ?? { ok: true, restored: false, from: state.info.branch, parked: false };
      if (outcome.ok === true) {
        state.info = { ...state.info, branch: payload.branch };
      }
      return outcome;
    },
    onFsChanged: () => () => {},
    onAssetsChanged: () => () => {},
    onCmsChanged: () => () => {},
    onCssChanged: () => () => {},
  };
  const render = (path = projectPath) =>
    act(async () =>
      root.render(
        React.createElement(DesktopPublishButton, {
          projectPath: path,
          flushSave: async () => order.push('saved'),
          refresh: async () => order.push('refreshed'),
          saveState: undefined,
          repository: repositoryProp,
          onOpenBranches: () => order.push('opened branches'),
          onBranchSwitched: async () => reloads.push('reloaded'),
        }),
      ),
    );
  await render();
  return { starts, checkouts, order, reloads, state, render };
}

async function clickGitHubPush() {
  await act(async () => document.querySelector('[aria-label="More publish options"]').click());
  await act(async () => document.querySelector('.stacki-publish-github > button').click());
}
const warning = () => document.querySelector('.stacki-branch-warning') ?? undefined;
const buttons = () => [...document.querySelectorAll('.stacki-branch-warning .modal-footer button')];
const button = (label) => buttons().find((candidate) => candidate.textContent === label);
const click = (element) => act(async () => element.click());

test('on the default branch Publish starts at once and asks nothing', async (context) => {
  const view = await publishing(context, { info: repository({}) });
  await clickGitHubPush();
  assert.equal(warning(), undefined);
  assert.equal(view.starts.length, 1);
});

test('on another branch every start asks first, and nothing is saved or sent before the answer', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }) });
  await clickGitHubPush();
  assert.notEqual(warning(), undefined);
  assert.equal(document.querySelector('.stacki-branch-warning .modal-header').textContent, 'Publish from feature/x?');
  assert.match(warning().textContent, /You are on feature\/x, not main\. Publishing sends this branch\./);
  assert.deepEqual(
    buttons().map((candidate) => candidate.textContent),
    ['Cancel', 'Switch to main first', 'Publish from feature/x'],
  );
  assert.equal(button('Publish from feature/x').className, 'primary');
  assert.equal(view.starts.length, 0);
  assert.equal(view.order.includes('saved'), false, 'nothing is saved before the answer');
});

test('the main Publish button asks too, not only the menu', async (context) => {
  // A saved publish setup whose default target is GitHub, so the main button starts a publish instead of opening setup.
  const view = await publishing(context, {
    info: repository({ branch: 'feature/x' }),
    metadata: {
      source: JSON.stringify({
        version: 1,
        defaultTarget: 'github',
        githubAccount: '',
        hosting: { provider: 'none' },
        buildScript: 'build',
        beforePublish: [],
        afterPublish: [],
      }),
    },
  });
  await act(async () => document.querySelector('.stacki-publish-main > button').click());
  assert.notEqual(warning(), undefined);
  assert.equal(view.starts.length, 0);
});

test('publishing from the branch carries on; Cancel never starts', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }) });
  await clickGitHubPush();
  await click(button('Cancel'));
  assert.equal(view.starts.length, 0);
  assert.equal(warning(), undefined);
  await clickGitHubPush();
  await click(button('Publish from feature/x'));
  assert.deepEqual(view.starts, [{ projectPath: '/project', target: 'github' }]);
});

test('the branch is read at the click, not trusted from a copy that may be seconds old', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }), repositoryProp: repository({ branch: 'main' }) });
  await clickGitHubPush();
  assert.notEqual(warning(), undefined, 'the cached copy said main; git says feature/x');
  assert.equal(view.starts.length, 0);
});

test('"Don\'t warn me again" is remembered for that branch in that project only', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }) });
  await clickGitHubPush();
  await act(async () => document.querySelector('.stacki-branch-warning input[type="checkbox"]').click());
  await click(button('Publish from feature/x'));
  assert.equal(view.starts.length, 1);
  await clickGitHubPush();
  assert.equal(warning(), undefined, 'the same branch no longer asks');
  assert.equal(view.starts.length, 2);
  view.state.info = repository({ branch: 'feature/y', branches: ['main', 'feature/y'] });
  await clickGitHubPush();
  assert.notEqual(warning(), undefined, 'another branch still asks');
  await click(button('Cancel'));
  view.state.info = repository({ branch: 'feature/x' });
  await view.render('/other-project');
  await clickGitHubPush();
  assert.notEqual(warning(), undefined, 'the same branch name in another project still asks');
});

test('publishing without ticking the box does not silence the branch', async (context) => {
  await publishing(context, { info: repository({ branch: 'feature/x' }) });
  await clickGitHubPush();
  await click(button('Publish from feature/x'));
  await clickGitHubPush();
  assert.notEqual(warning(), undefined);
});

test('a detached HEAD asks in its own words, offers no "don\'t warn" and is never silenced', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'HEAD' }) });
  await clickGitHubPush();
  assert.equal(document.querySelector('.stacki-branch-warning .modal-header').textContent, 'Publish from here?');
  assert.match(warning().textContent, /not on main or any other branch \(detached HEAD\)/);
  assert.equal(warning().querySelector('input[type="checkbox"]') ?? undefined, undefined);
  assert.equal(view.starts.length, 0);
});

test('switching first with uncommitted changes explains and changes nothing', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x', dirty: true }) });
  await clickGitHubPush();
  await click(button('Switch to main first'));
  assert.equal(view.checkouts.length, 0, 'git is never asked to move a dirty tree');
  assert.notEqual(warning(), undefined, 'the question stays open');
  assert.match(warning().querySelector('.stacki-branch-warning-problem').textContent, /changes on feature\/x that are not committed/);
  assert.equal(view.starts.length, 0);
});

test('switching first on a clean tree sends the name to git as data, reloads, then publishes', async (context) => {
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }) });
  await clickGitHubPush();
  await click(button('Switch to main first'));
  assert.equal(view.checkouts.length, 1);
  assert.equal(view.checkouts[0].branch, 'main');
  assert.equal(view.checkouts[0].projectPath, '/project');
  assert.equal(view.reloads.length, 1);
  assert.equal(warning(), undefined);
  assert.equal(view.starts.length, 1);
  assert.ok(view.order.indexOf('refreshed') < view.order.length, 'git was re-read after the switch');
});

test('a checkout git refuses keeps the question open and sends nothing', async (context) => {
  const blocked = { ok: false, blocked: true, from: 'feature/x', branch: 'main', files: ['src/pages/index.astro'] };
  const view = await publishing(context, { info: repository({ branch: 'feature/x' }), checkout: blocked });
  await clickGitHubPush();
  await click(button('Switch to main first'));
  assert.equal(view.checkouts.length, 1);
  assert.notEqual(warning(), undefined);
  assert.match(warning().querySelector('.stacki-branch-warning-problem').textContent, /not committed/);
  assert.equal(view.starts.length, 0);
  assert.equal(view.reloads.length, 0);
});

test('no repository asks nothing about branches', async (context) => {
  await publishing(context, { info: { isRepo: false } });
  await clickGitHubPush();
  assert.equal(warning(), undefined);
});

test('a repository with no commits yet asks nothing about branches', async (context) => {
  const view = await publishing(context, { info: repository({ branch: '(no commits yet)', head: undefined }) });
  await clickGitHubPush();
  assert.equal(warning(), undefined);
  assert.equal(view.starts.length, 1);
});

test('every publish entry point goes through the gate and nothing else starts one', () => {
  const source = fs.readFileSync(repoPath('src/app/shell/DesktopPublishButton.tsx'), 'utf8');
  assert.match(source, /publish=\{\(target\) => gate\.guard\(/);
  assert.equal(source.match(/startPublish\(/g).length, 1, 'one place starts a publish');
  assert.equal((source.match(/action\.publish\(/g) ?? []).length, 2, 'the gated menu path and the commit-message follow-up of an already gated start');
  const control = fs.readFileSync(repoPath('src/features/publishing/PublishControl.tsx'), 'utf8');
  assert.equal((control.match(/\bpublish\(target\)/g) ?? []).length, 1, 'PublishControl hands every target to the one publish callback');
});

test('the chip is quiet on the default branch and amber on any other, with the full name in its tooltip', async (context) => {
  const { BranchIndicator, forgetRememberedBranches } = await bundle('src/features/git/BranchIndicator.tsx', 'branch-indicator');
  forgetRememberedBranches();
  const root = installDom(context);
  const show = (info, projectPath = '/p', onOpen = () => {}) =>
    act(async () => root.render(React.createElement(BranchIndicator, { projectPath, info, onOpen })));
  const chip = () => document.querySelector('.stacki-branch-chip');
  await show(repository({}));
  assert.equal(chip().dataset.state, 'quiet');
  assert.equal(chip().textContent, 'main');
  assert.equal(chip().title, 'Current branch: main');
  const long = 'feature/a-very-long-branch-name-that-keeps-going-and-going';
  await show(repository({ branch: long }));
  assert.equal(chip().dataset.state, 'warning');
  assert.equal(chip().textContent, long, 'the text is whole; CSS ellipsizes it');
  assert.equal(chip().title, `Current branch: ${long}`);
  await show(repository({ branch: 'HEAD' }));
  assert.equal(chip().dataset.state, 'warning');
  assert.equal(chip().textContent, 'Detached HEAD');
  await show(repository({ branch: 'main' }));
  assert.equal(chip().dataset.state, 'quiet', 'it follows a branch changed outside the app on the next read');
});

test('the chip draws nothing without a repository or commits, a placeholder before the first read, and the last branch at once', async (context) => {
  const { BranchIndicator, forgetRememberedBranches } = await bundle('src/features/git/BranchIndicator.tsx', 'branch-indicator');
  forgetRememberedBranches();
  const root = installDom(context);
  const show = (info, projectPath, onOpen = () => {}) => act(async () => root.render(React.createElement(BranchIndicator, { projectPath, info, onOpen })));
  await show({ isRepo: false }, '/none');
  assert.equal(document.querySelector('.stacki-branch-chip') ?? undefined, undefined);
  assert.equal(document.querySelector('.stacki-branch-chip-skeleton') ?? undefined, undefined);
  await show(repository({ head: undefined, branch: '(no commits yet)' }), '/fresh');
  assert.equal(document.querySelector('.stacki-branch-chip') ?? undefined, undefined);
  await show(undefined, '/never-read');
  assert.equal(document.querySelector('.stacki-branch-chip') ?? undefined, undefined);
  assert.notEqual(document.querySelector('.stacki-branch-chip-skeleton .ui-skeleton') ?? undefined, undefined, 'a shape, never the word "Loading"');
  assert.doesNotMatch(document.body.textContent, /Loading|…/);
  await show(repository({ branch: 'feature/x' }), '/seen');
  await show(undefined, '/seen');
  assert.equal(document.querySelector('.stacki-branch-chip').textContent, 'feature/x', 'the last read paints before the next one answers');
  assert.equal(document.querySelector('.stacki-branch-chip-skeleton') ?? undefined, undefined);
});

test('clicking the chip opens the existing branch switcher; without one it is inert', async (context) => {
  const { BranchIndicator, forgetRememberedBranches } = await bundle('src/features/git/BranchIndicator.tsx', 'branch-indicator');
  forgetRememberedBranches();
  const root = installDom(context);
  let opened = 0;
  await act(async () => root.render(React.createElement(BranchIndicator, { projectPath: '/p', info: repository({}), onOpen: () => (opened += 1) })));
  await act(async () => document.querySelector('.stacki-branch-chip').click());
  assert.equal(opened, 1);
  await act(async () => root.render(React.createElement(BranchIndicator, { projectPath: '/p', info: repository({}), onOpen: undefined })));
  assert.equal(document.querySelector('.stacki-branch-chip').disabled, true);
});

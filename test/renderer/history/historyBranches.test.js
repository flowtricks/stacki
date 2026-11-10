// Goal: the Git panel owns branch and commit controls without a title-bar chip.
// Methodology: mount the real controls and graph against a parsed, stubbed IPC transport;
// Exercise filtering, create/switch, deletion consent, conflicts and partial commit recovery.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

test('Git controls stay open in the panel and preserve repository actions', async () => {
  const directory = repoPath('node_modules/.stacki-test/git-panel');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'panel.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        `export {default as Controls} from ${sourceSpecifier('src/features/git/GitChip.tsx')};`,
        `export {default as Panel} from ` + `${sourceSpecifier('src/features/history/HistoryPanel.tsx')};`,
        `export {ConfirmHost} from ${sourceSpecifier('src/ui/ConfirmDialog.tsx')};`,
      ].join('\n'),
      resolveDir: repoPath('src'),
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = () => ({ matches: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { Controls, Panel, ConfirmHost } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const requests = [];
  const checkout = { ok: true, restored: false, from: 'main', parked: false };
  let checkoutReply = async () => checkout;
  let commitError;
  let saveError;
  let pullReply = async () => ({ ok: true, into: 'main', changed: true });
  let info = {
    isRepo: true,
    branch: 'main',
    branches: ['main', 'feature'],
    parked: [],
    head: 'a'.repeat(40),
    dirty: true,
    ahead: 0,
    trunk: 'main',
  };
  const files = ['one.astro', 'two.astro'].map((file) => ({
    path: file,
    status: 'M',
    label: file,
    kind: 'page',
    staged: false,
    untracked: false,
  }));
  window.avb = {
    gitPull: async (payload) => {
      requests.push(['pull', payload]);
      return pullReply();
    },
    gitLog: async (payload) => {
      requests.push(['log', payload]);
      return { commits: [], atEnd: true };
    },
    gitCheckout: async (payload) => {
      requests.push(['checkout', payload]);
      return checkoutReply();
    },
    gitCommit: async (payload) => {
      requests.push(['commit', payload]);
      if (commitError) {
        throw new Error(commitError);
      }
      return { ok: true, files: 1 };
    },
    gitStatus: async () => files,
    gitDeleteBranch: async (payload) => {
      requests.push(['delete', payload]);
      return { ok: true };
    },

    gitInit: async () => {
      requests.push(['init']);
      return { ok: true };
    },
    openExternal: async (url) => {
      requests.push(['external', url]);
    },
  };
  const props = {
    project: { path: '/project', name: 'Project' },
    busy: undefined,
    incoming: { kind: 'ready', commits: 1 },
    flushSave: async () => {
      requests.push(['save']);
      if (saveError) {
        throw new Error(saveError);
      }
    },
    refresh: async () => {
      requests.push(['refresh']);
    },
    onWorktreeChanged: async () => {
      requests.push(['reload']);
    },
    withBranchChange: async (work) => {
      requests.push(['pause-preview']);
      try {
        return await work();
      } finally {
        requests.push(['restart-preview']);
      }
    },
    showToast: (message, tone) => {
      requests.push(['toast', message, tone]);
    },
  };
  const render = (extra = {}) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          undefined,
          React.createElement(Panel, {
            project: props.project,
            gitInfo: info,
            controls: React.createElement(Controls, { ...props, info, ...extra }),
          }),
          React.createElement(ConfirmHost),
        ),
      ),
    );
  const click = (element) => act(async () => element.click());
  const button = (label) => Array.from(document.querySelectorAll('button')).find((element) => element.textContent.trim() === label);
  const fill = async (selector, value) =>
    act(async () => {
      const input = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const checkouts = () => requests.filter(([kind]) => kind === 'checkout');
  try {
    await render();
    assert.equal(document.querySelector('h2').textContent, 'Git');
    assert.equal(document.querySelector('.history-body').firstElementChild.className, 'git-panel-controls');
    // The graph's section reads as designers name it, with its chevron at the row's end.
    const graphHead = document.querySelector('.history-section-head');
    assert.equal(graphHead.querySelector('.history-section-title').textContent, 'Version history');
    assert.ok(graphHead.lastElementChild.classList.contains('history-section-chevron'));
    assert.equal(document.body.textContent.includes('Source Control Graph'), false);
    assert.equal(document.querySelector('.git-chip') === null, true);
    assert.equal(document.querySelector('.dropdown') === null, true);
    assert.equal(document.querySelector('[aria-label="main, current branch"]').disabled, true);
    assert.equal(document.querySelector('.history-branch-row.active .row-action') === null, true);
    assert.ok(document.querySelector('[title="Merge feature into main"]'));
    assert.ok(document.querySelector('[title="Delete feature"]'));
    assert.ok(button('Commit all changes'));
    assert.equal(document.querySelector('.git-commit-destination').textContent, 'Commit to main');
    assert.ok(document.querySelector('.git-commit-destination .history-graph-color-0'));
    assert.equal(button('Publish to GitHub…'), undefined);
    assert.equal(
      [...document.querySelectorAll('h3')].some((heading) => heading.textContent === 'GitHub'),
      false,
    );
    assert.equal(button('Pull from GitHub'), undefined);
    info = { ...info, remote: 'https://github.com/example/project.git' };
    await render();
    assert.ok(button('Pull from GitHub').querySelector('svg'));
    await render({ incoming: { kind: 'ready', commits: 0 } });
    assert.equal(button('Pull from GitHub').disabled, true);
    assert.equal(button('Pull from GitHub').title, 'No changes to pull');
    const noIncomingRequests = requests.filter(([kind]) => kind === 'pull').length;
    await click(button('Pull from GitHub'));
    assert.equal(requests.filter(([kind]) => kind === 'pull').length, noIncomingRequests);
    await render({ incoming: { kind: 'checking' } });
    assert.equal(button('Pull from GitHub').disabled, true);
    await render({ incoming: { kind: 'unavailable', message: 'Offline' } });
    assert.equal(button('Pull from GitHub').disabled, true);
    assert.match(button('Pull from GitHub').title, /Offline/);
    await render();
    assert.equal(button('Pull from GitHub').disabled, false);
    assert.equal(button('Pull from GitHub').title, '1 commit to pull');
    const pullStart = requests.length;
    await click(button('Pull from GitHub'));
    assert.deepEqual(
      requests.slice(pullStart).filter(([kind]) => kind !== 'log'),
      [['save'], ['pull', { projectPath: '/project', branch: 'main' }], ['toast', 'Pulled changes from GitHub', 'success'], ['refresh'], ['reload']],
    );
    pullReply = async () => ({ ok: true, into: 'main', changed: false });
    await click(button('Pull from GitHub'));
    assert.ok(requests.some(([kind, text]) => kind === 'toast' && /Already up to date/.test(text)));
    let finishPull;
    pullReply = () =>
      new Promise((resolve) => {
        finishPull = resolve;
      });
    const beforeRepeatedPull = requests.filter(([kind]) => kind === 'pull').length;
    await act(async () => {
      const pull = button('Pull from GitHub');
      pull.click();
      pull.click();
    });
    assert.equal(requests.filter(([kind]) => kind === 'pull').length, beforeRepeatedPull + 1);
    assert.equal(button('Pulling…').disabled, true);
    await act(async () => finishPull({ ok: true, into: 'main', changed: false }));
    pullReply = async () => ({
      ok: false,
      dirty: true,
      from: 'main',
      branch: 'refs/remotes/origin/main',
      files: ['one.astro'],
    });
    await click(button('Pull from GitHub'));
    assert.match(requests.filter(([kind]) => kind === 'toast').at(-1)[1], /Commit your local/);
    pullReply = async () => ({
      ok: false,
      conflicted: true,
      from: 'main',
      branch: 'refs/remotes/origin/main',
      files: [{ path: 'one.astro', ours: 'local', theirs: 'remote', parts: undefined }],
    });
    await click(button('Pull from GitHub'));
    assert.ok(document.querySelector('.modal'));
    assert.match(document.querySelector('.modal').textContent, /one.astro/);
    await click(button('Cancel'));
    assert.equal(document.querySelector('.modal') === null, true);
    await render({ busy: 'Publishing…' });
    assert.equal(button('Pull from GitHub').disabled, true);
    await render();
    saveError = 'Save failed';
    const pullsBefore = requests.filter(([kind]) => kind === 'pull').length;
    await click(button('Pull from GitHub'));
    assert.equal(requests.filter(([kind]) => kind === 'pull').length, pullsBefore);
    saveError = undefined;
    pullReply = async () => {
      throw new Error('Network unavailable');
    };
    await click(button('Pull from GitHub'));
    assert.ok(requests.some(([kind, text]) => kind === 'toast' && /Network unavailable/.test(text)));
    assert.equal(button('Pull from GitHub').disabled, false);
    // The branch filter is the app's Dropdown, not a native select: it opens its
    // own menu, marks the chosen row at its end, and filters the graph on pick.
    const filter = document.querySelector('[aria-label="Filter commits by branch"]');
    assert.equal(filter.tagName, 'BUTTON');
    assert.ok(filter.classList.contains('dd-trigger'));
    assert.equal(filter.textContent, 'All branches');
    assert.equal(document.querySelector('.git-panel-controls select, .history-graph-toolbar select') === null, true);
    await click(filter);
    const filterRows = [...document.querySelectorAll('.dd-popup .dd-option')];
    assert.deepEqual(
      filterRows.map((row) => row.querySelector('.dd-option-label').textContent),
      ['All branches', 'Current branch'],
    );
    assert.ok(filterRows[0].lastElementChild.classList.contains('dd-check'));
    assert.ok(filterRows[0].querySelector('.dd-check svg'));
    const logsBeforeHover = requests.filter(([kind]) => kind === 'log').length;
    await act(async () => filterRows[1].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    assert.equal(requests.filter(([kind]) => kind === 'log').length, logsBeforeHover, 'Hovering a filter row previews nothing');
    await click(filterRows[1]);
    assert.equal(document.querySelector('.dd-popup') === null, true);
    assert.equal(filter.textContent, 'Current branch');
    assert.equal(filter.closest('.history-graph-filter').title, 'Showing commits on main');
    assert.equal(requests.filter(([kind]) => kind === 'log').at(-1)[1].ref, 'HEAD');
    // Keyboard: the arrows move, Enter picks, Escape closes without changing the filter.
    await act(async () => filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    assert.ok(document.querySelector('.dd-popup'));
    await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('.dd-popup') === null, true);
    assert.equal(filter.textContent, 'Current branch');
    assert.equal(checkouts().length, 0);
    await click(document.querySelector('[title="Merge feature into main"]'));
    assert.match(document.querySelector('.modal').textContent, /Merge “feature” into “main”/);
    await click(button('Cancel'));
    await click(document.querySelector('[title="Delete feature"]'));
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /Delete.*feature/);
    assert.equal(document.activeElement, button('Cancel'));
    assert.equal(
      requests.some(([kind]) => kind === 'delete'),
      false,
    );
    await click(button('Cancel'));
    assert.equal(
      requests.some(([kind]) => kind === 'delete'),
      false,
    );
    await click(document.querySelector('[title="Delete feature"]'));
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="alertdialog"]') === null, true);
    assert.equal(
      requests.some(([kind]) => kind === 'delete'),
      false,
    );
    await click(document.querySelector('[title="Delete feature"]'));
    await act(async () => {
      const dialog = document.querySelector('[role="alertdialog"]');
      dialog.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('[role="alertdialog"]') === null, true);
    assert.equal(
      requests.some(([kind]) => kind === 'delete'),
      false,
    );
    await click(document.querySelector('[title="Delete feature"]'));
    await click(button('Delete branch'));
    assert.deepEqual(
      requests.filter(([kind]) => kind === 'delete'),
      [['delete', { projectPath: '/project', branch: 'feature' }]],
    );
    assert.equal(checkouts().length, 0);

    assert.equal(document.querySelector('[aria-label="New branch name"]') === null, true);
    await click(button('New branch'));
    assert.equal(document.activeElement.getAttribute('aria-label'), 'New branch name');
    assert.equal(button('Create').disabled, true);
    await fill('[aria-label="New branch name"]', 'main');
    assert.equal(button('Create').disabled, true);
    assert.match(document.querySelector('.git-branch-editor .git-hint').textContent, /already exists/);
    await act(async () => {
      document.querySelector('.git-branch-editor form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(checkouts().length, 0);
    await click(document.querySelector('[aria-label="Close new branch"]'));
    assert.equal(document.querySelector('[aria-label="New branch name"]') === null, true);
    assert.equal(document.activeElement, button('New branch'));
    await click(button('New branch'));
    assert.equal(document.querySelector('[aria-label="New branch name"]').value, '');
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.querySelector('[aria-label="New branch name"]') === null, true);
    await click(button('New branch'));
    await fill('[aria-label="New branch name"]', 'new branch');
    assert.equal(document.querySelector('[aria-label="New branch name"]').value, 'new-branch');
    await click(button('Create'));
    assert.equal(document.querySelector('[aria-label="New branch name"]') === null, true);
    assert.equal(checkouts().at(-1)[1].create, true);
    assert.equal(checkouts().at(-1)[1].branch, 'new-branch');
    let finishSwitch;
    checkoutReply = () =>
      new Promise((resolve) => {
        finishSwitch = resolve;
      });
    const beforeSwitch = checkouts().length;
    const switchStart = requests.length;
    await act(async () => {
      const target = document.querySelector('[aria-label="Switch to feature"]');
      target.click();
      target.click();
    });
    assert.equal(checkouts().length, beforeSwitch + 1);
    assert.deepEqual(
      requests.slice(switchStart).map(([kind]) => kind),
      ['save', 'pause-preview', 'checkout'],
    );
    assert.equal(document.querySelector('[aria-label="Switch to feature"]').disabled, true);
    await act(async () => finishSwitch({ ...checkout, parked: true, parkedFrom: 'main' }));
    assert.deepEqual(requests.slice(-2), [['refresh'], ['reload']]);
    assert.ok(requests.slice(switchStart).some(([kind]) => kind === 'restart-preview'));
    assert.equal(document.querySelector('.modal') === null, true);
    assert.match(requests.filter(([kind]) => kind === 'toast').at(-1)[1], /waiting on main/);
    info = { ...info, branch: 'feature', head: 'b'.repeat(40) };
    await render();
    assert.equal(document.querySelector('.git-commit-destination').textContent, 'Commit to feature');
    assert.ok(document.querySelector('.git-commit-destination .history-graph-color-1'));
    assert.equal(document.querySelector('[aria-label="feature, current branch"]').disabled, true);
    assert.equal(document.querySelector('.history-branch-row.active .row-action') === null, true);
    assert.ok(document.querySelector('[title="Merge main into feature"]'));
    assert.equal(document.querySelector('[title="Delete main"]') === null, true);

    checkoutReply = async () => ({
      ok: false,
      blocked: true,
      from: 'feature',
      branch: 'main',
      files: ['one.astro'],
    });
    await click(document.querySelector('[aria-label="Switch to main"]'));
    assert.ok(button('Leave them on feature'));
    await click(button('Cancel'));
    assert.equal(document.querySelector('.modal') === null, true);
    await click(document.querySelector('[aria-label="Switch to main"]'));
    checkoutReply = async () => checkout;
    await click(button('Leave them on feature'));
    assert.equal(checkouts().at(-1)[1].parkFirst, true);
    assert.equal(document.querySelector('.modal') === null, true);

    await fill('[aria-label="Commit message"]', 'Update home');
    await click(document.querySelector('[aria-label="Choose what to commit"]'));
    const fileCheckbox = document.querySelector('dialog input[type="checkbox"]');
    assert.ok(fileCheckbox);
    await click(fileCheckbox);
    assert.equal(document.querySelector('.git-panel-controls .file-browser') === null, true);
    await click(button('Done'));
    assert.equal(document.querySelector('dialog') === null, true);
    await click(document.querySelector('[aria-label="Choose what to commit"]'));
    await act(async () => document.querySelector('dialog').dispatchEvent(new window.Event('cancel', { cancelable: true })));
    assert.equal(document.querySelector('dialog') === null, true);
    commitError = 'Commit failed';
    await click(button('Commit 1 file'));
    assert.equal(document.querySelector('[aria-label="Commit message"]').value, 'Update home');
    assert.match(requests.filter(([kind]) => kind === 'toast').at(-1)[1], /Commit failed/);
    commitError = undefined;
    await click(button('Commit 1 file'));
    const committed = requests.filter(([kind]) => kind === 'commit').at(-1)[1];
    assert.equal(committed.message, 'Update home');
    assert.equal(committed.paths.length, 1);
    assert.equal(document.querySelector('[aria-label="Commit message"]').value, '');
    assert.equal(document.querySelector('.git-pick') === null, true);

    const beforeFailure = checkouts().length;
    saveError = 'Save failed';
    await click(document.querySelector('[aria-label="Switch to main"]'));
    assert.equal(checkouts().length, beforeFailure);
    assert.match(requests.filter(([kind]) => kind === 'toast').at(-1)[1], /Save failed/);
    saveError = undefined;
    info = {
      ...info,
      remote: 'https://github.com/example/project.git',
      hasUpstream: true,
      ahead: 2,
    };
    await render();
    assert.equal(button('Push 2 commits'), undefined);
    assert.equal(document.querySelector('.repo-link') === null, true);
    await render({ busy: 'Saving…' });
    assert.equal(document.querySelector('[aria-label="Switch to main"]').disabled, true);
    info = { isRepo: false };
    await render();
    assert.ok(button('Initialize Git'));
    assert.equal(document.querySelector('[aria-label="Filter commits by branch"]') === null, true);
    await click(button('Initialize Git'));
    assert.ok(requests.some(([kind]) => kind === 'init'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete global[key];
    }
  }
});

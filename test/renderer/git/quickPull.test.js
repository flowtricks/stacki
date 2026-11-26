// Goal: the title bar's pull button and ⌥⇧G pull through the same session as the Git panel, with that panel closed:
// the dirty refusal and the merge review work there, one pull runs at a time, the chord stays out of typing places
// and refused states, and a quiet project shows nothing.
// Methodology: mount the real window session (DesktopGitPull.tsx), the real incoming check and the real merge review
// in jsdom, over IPC stubs that run the real main-process git code against two clones of a local bare remote. No
// network, no GitHub and no project of anyone's; the Git panel is never mounted.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');
const { waitFor } = require('../../helpers/waitFor');
const { pullBranch, readIncomingCommits } = require('#dist/electron/git/gitPull.js');
const { resolveMerge } = require('#dist/electron/git/gitBranches.js');

const execute = promisify(execFile);
const git = (cwd, args) =>
  execute('git', args, {
    cwd,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });

async function repositories(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-quick-pull-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const reader = path.join(root, 'reader');
  const identity = async (directory) => {
    for (const [key, value] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
    ]) {
      await git(directory, ['config', key, value]);
    }
  };
  const commit = async (directory, content, file = 'page.txt') => {
    fs.writeFileSync(path.join(directory, file), `${content}\n`);
    await git(directory, ['add', file]);
    await git(directory, ['commit', '--message', content]);
  };
  await git(root, ['init', '--bare', '--initial-branch=main', remote]);
  await git(root, ['clone', remote, author]);
  await identity(author);
  await commit(author, 'base');
  await git(author, ['push', 'origin', 'main']);
  await git(root, ['clone', remote, reader]);
  await identity(reader);
  return {
    reader,
    remote,
    commit,
    // A commit someone else made and sent to the local bare remote.
    incoming: async (content, file) => {
      await commit(author, content, file);
      await git(author, ['push', 'origin', 'main']);
    },
    read: (file = 'page.txt') => fs.readFileSync(path.join(reader, file), 'utf8'),
  };
}

async function bundle() {
  const directory = repoPath('node_modules/.stacki-test/quick-pull');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'quick-pull.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        `export {useDesktopGit, DesktopGitContext, TitleBarPull} from ${sourceSpecifier('src/app/shell/DesktopGitPull.tsx')};`,
        `export {GitSessionDialogs} from ${sourceSpecifier('src/features/git/GitSessionDialogs.tsx')};`,
        `export {useGitIncoming} from ${sourceSpecifier('src/features/git/useGitIncoming.ts')};`,
        `export {readGitInfo} from ${sourceSpecifier('src/features/git/gitChipBridge.ts')};`,
        `export {setActualRole} from ${sourceSpecifier('src/lib/currentRole.ts')};`,
        `export {ADMIN_VIEW, parseProjectRoles, roleViewOf} from ${sourceSpecifier('shared/properties/projectRoles.ts')};`,
        `export {holdWindow} from ${sourceSpecifier('src/ui/busyLock.ts')};`,
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
  return outfile;
}

async function mount(context) {
  const repository = await repositories(context);
  const outfile = await bundle();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'KeyboardEvent', 'Window']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = () => ({ matches: true, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  // The merge review draws a code editor, which reads these from the page.
  for (const key of ['MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
    global[key] = dom.window[key].bind?.(dom.window) ?? dom.window[key];
  }
  global.MutationObserver = dom.window.MutationObserver;
  window.Range.prototype.getClientRects = () => [];
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  delete require.cache[outfile];
  const app = require(outfile);

  const events = [];
  const toasts = [];
  let gate;
  window.avb = {
    platform: 'darwin',
    gitInfo: async () => {
      const line = async (args) => (await git(repository.reader, args)).stdout.trim();
      const branch = await line(['rev-parse', '--abbrev-ref', 'HEAD']);
      return {
        isRepo: true,
        // The panel and the incoming check only need to know a remote exists; the git calls use the clone's own origin.
        remote: repository.remote,
        branch,
        branches: [branch],
        parked: [],
        head: await line(['rev-parse', 'HEAD']),
        dirty: (await line(['status', '--porcelain'])) !== '',
        ahead: 0,
        trunk: 'main',
      };
    },
    gitIncoming: async (payload) => {
      events.push('check');
      return readIncomingCommits(git, payload);
    },
    gitPull: async (payload) => {
      events.push('pull');
      await gate;
      return pullBranch(git, payload);
    },
    gitResolveMerge: async (payload) => {
      events.push('resolve');
      return resolveMerge(git, payload);
    },
    openExternal: async () => {},
  };

  const state = { defaults: 'idle', canvas: 'idle', property: 'idle', rerender: () => {} };
  function Window() {
    const [info, setInfo] = React.useState(undefined);
    const [, setRevision] = React.useState(0);
    state.rerender = () => setRevision((value) => value + 1);
    const incoming = app.useGitIncoming(repository.reader, info);
    state.incoming = incoming.state;
    state.info = info;
    const refreshGit = React.useCallback(async () => {
      const result = await app.readGitInfo(repository.reader);
      assert.ok(result.ok);
      setInfo(result.value);
    }, []);
    state.refresh = refreshGit;
    React.useEffect(() => void refreshGit(), [refreshGit]);
    const desktop = app.useDesktopGit(
      {
        project: { path: repository.reader, name: 'Fixture' },
        gitInfo: info,
        gitIncoming: incoming.state,
        recordGitIncoming: incoming.record,
        refreshGit,
        busy: undefined,
        showToast: (message, kind) => toasts.push([message, kind]),
        flushSave: async () => events.push('save'),
        previewRef: undefined,
        exitCommitPreview: async () => {},
        reloadFromDisk: async () => events.push('reload'),
        defaultsCanvas: { state: { kind: state.defaults } },
        propertySave: { phase: state.property },
      },
      { state: { kind: state.canvas } },
    );
    state.session = desktop.session;
    return React.createElement(
      app.DesktopGitContext.Provider,
      { value: desktop },
      React.createElement(app.TitleBarPull),
      React.createElement(app.GitSessionDialogs, { session: desktop.session }),
      React.createElement('input', { id: 'field' }),
      React.createElement('textarea', { id: 'area' }),
      React.createElement('div', { contentEditable: true, suppressContentEditableWarning: true }, React.createElement('span', { id: 'rich' }, 'x')),
      React.createElement('div', { className: 'cm-editor' }, React.createElement('div', { id: 'code' })),
      React.createElement('div', { role: 'dialog' }, React.createElement('button', { id: 'in-dialog' })),
    );
  }
  const root = createRoot(document.getElementById('root'));
  app.setActualRole(app.ADMIN_VIEW);
  await act(async () => root.render(React.createElement(Window)));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  // Real git runs behind each step, so wait inside act until the state it leads to has rendered.
  const until = (condition, what) =>
    waitFor({
      what,
      read: async () => {
        // One turn of the event loop inside act renders what has arrived; the poll's interval is the wait.
        await act(async () => new Promise((resolve) => setImmediate(resolve)));
        return Boolean(condition());
      },
      until: (value) => value,
      pollIntervalMs: 20,
      pollCountMax: 400,
    });
  const press = async (options = {}, target = window) => {
    const event = new window.KeyboardEvent('keydown', {
      key: '˝',
      code: 'KeyG',
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  const view = {
    repository,
    app,
    act,
    state,
    events,
    toasts,
    until,
    press,
    button: () => document.querySelector('.stacki-pull-button') ?? undefined,
    count: (name) => events.filter((event) => event === name).length,
    // The window-return check: what a person coming back from GitHub's website triggers.
    comeBack: () => act(async () => window.dispatchEvent(new window.Event('focus'))),
    hold: () => {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    settled: () => until(() => state.session.busy === undefined, 'the git action finishes'),
  };
  await until(() => state.incoming.kind === 'ready', 'the first incoming check answers');
  return view;
}

test('nothing to pull shows nothing, and the chord checks again, then pulls or says there is nothing', async (context) => {
  const view = await mount(context);
  assert.equal(view.button(), undefined, 'no placeholder, ghost or checking state');
  const checks = view.count('check');
  assert.equal(await view.press(), true);
  await view.until(() => view.toasts.length === 1, 'the chord answers');
  assert.deepEqual(view.toasts, [['No changes to pull', 'info']]);
  assert.equal(view.count('check'), checks + 1);
  assert.deepEqual(
    view.events.filter((event) => event !== 'check'),
    [],
    'nothing is saved, pulled or reloaded when there is nothing to pull',
  );

  // Commits arrive that the routine check has not seen yet.
  await view.repository.incoming('from GitHub');
  assert.equal(view.button(), undefined);
  await view.press();
  await view.press();
  await view.press();
  await view.until(() => view.repository.read() === 'from GitHub\n', 'the chord pulls');
  await view.settled();
  assert.equal(view.count('pull'), 1, 'repeated presses start one pull');
  assert.deepEqual(view.toasts.at(-1), ['Pulled changes from GitHub', 'success']);
  assert.deepEqual(
    view.events.filter((event) => event !== 'check'),
    ['save', 'pull', 'reload'],
  );
  assert.equal(view.button(), undefined, 'gone after a successful pull');
});

test('the button shows the count, spins in place while pulling and goes after the pull', async (context) => {
  const view = await mount(context);
  await view.repository.incoming('one');
  await view.repository.incoming('two');
  await view.comeBack();
  await view.until(() => view.button() !== undefined, 'the button appears');
  assert.equal(view.button().textContent, '2');
  assert.equal(view.button().getAttribute('aria-label'), '2 commits to pull');
  assert.equal(view.button().getAttribute('aria-keyshortcuts'), 'Alt+Shift+G');
  assert.ok(view.button().querySelector('.stacki-pull-mark svg'));
  const release = view.hold();
  await view.act(async () => view.button().click());
  await view.until(() => view.count('pull') === 1, 'the click pulls');
  assert.equal(view.button().textContent, '2');
  assert.equal(view.button().getAttribute('aria-busy'), 'true');
  assert.ok(view.button().querySelector('.stacki-pull-mark > .mini-spinner'), 'the spinner takes the arrow’s box');
  await view.act(async () => view.button().click());
  await view.press();
  // The panel's button calls the same session, so the lock covers it too.
  await view.act(async () => view.state.session.pull(2));
  assert.equal(view.count('pull'), 1);
  await view.act(async () => release());
  await view.settled();
  assert.equal(view.repository.read(), 'two\n');
  assert.equal(view.button(), undefined);
  assert.equal(view.count('pull'), 1);
});

test('with the panel closed, work in the way is refused with a toast and kept', async (context) => {
  const view = await mount(context);
  await view.repository.incoming('theirs');
  fs.writeFileSync(path.join(view.repository.reader, 'page.txt'), 'not committed\n');
  await view.press();
  await view.until(() => view.toasts.length > 0, 'the pull answers');
  await view.settled();
  assert.match(view.toasts.at(-1)[0], /^Commit your local changes before pulling/);
  assert.equal(view.toasts.at(-1)[1], 'error');
  assert.equal(view.repository.read(), 'not committed\n');
  assert.equal(view.button().textContent, '1', 'there is still something to pull');
});

test('with the panel closed, a conflict opens the merge review, which finishes the pull', async (context) => {
  const view = await mount(context);
  await view.repository.incoming('theirs');
  await view.repository.commit(view.repository.reader, 'mine');
  await view.state.refresh();
  await view.comeBack();
  await view.until(() => view.button() !== undefined, 'the button appears');
  await view.act(async () => view.button().click());
  await view.until(() => document.querySelector('.conflict-modal') instanceof window.Element, 'the review opens');
  await view.settled();
  assert.match(document.querySelector('.conflict-modal').textContent, /page\.txt/);
  assert.equal(view.repository.read(), 'mine\n', 'the working tree is untouched while the review is open');
  assert.equal(view.button().textContent, '1');
  // An open review is the pull under way: neither the chord nor the button starts another.
  const pulls = view.count('pull');
  await view.press();
  await view.act(async () => view.button().click());
  assert.equal(view.count('pull'), pulls);
  const find = (text) => [...document.querySelectorAll('.conflict-modal button')].find((element) => element.textContent.trim() === text);
  await view.act(async () => find('Keep refs/remotes/origin/main').click());
  await view.act(async () => find('Merge result').click());
  await view.until(() => !(document.querySelector('.conflict-modal') instanceof window.Element), 'the review closes');
  await view.settled();
  assert.equal(view.repository.read(), 'theirs\n');
  assert.equal(view.button(), undefined);
});

test('the chord follows the typing policy and takes only its own keys', async (context) => {
  const view = await mount(context);
  await view.repository.incoming('theirs');
  const checks = view.count('check');
  for (const id of ['field', 'area', 'rich', 'code', 'in-dialog']) {
    assert.equal(await view.press({}, document.getElementById(id)), false, `${id} keeps the key`);
  }
  for (const other of [{ shiftKey: false }, { altKey: false }, { ctrlKey: true }, { metaKey: true }, { code: 'KeyH' }, { isComposing: true }]) {
    assert.equal(await view.press(other), false, JSON.stringify(other));
  }
  await view.press({ repeat: true });
  assert.equal(view.count('check'), checks);
  assert.equal(view.count('pull'), 0);
});

test('refused states and a role without Git have no button and no chord', async (context) => {
  const view = await mount(context);
  await view.repository.incoming('theirs');
  await view.comeBack();
  await view.until(() => view.button() !== undefined, 'the button appears');
  for (const [key, value] of [
    ['defaults', 'editing'],
    ['canvas', 'open'],
    ['property', 'saving'],
  ]) {
    const before = view.state[key];
    view.state[key] = value;
    await view.act(async () => view.state.rerender());
    assert.equal(view.button(), undefined, `${key}: no button`);
    await view.press();
    await view.act(async () => view.state.session.pull(1));
    view.state[key] = before;
    await view.act(async () => view.state.rerender());
  }
  assert.equal(view.count('pull'), 0);
  // Design mode and the busy cover hold the window.
  const release = view.app.holdWindow();
  await view.press();
  await view.act(async () => view.button().click());
  release();
  assert.equal(view.count('pull'), 0);
  const roles = view.app.parseProjectRoles({
    version: 1,
    defaultRole: 'client',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'client', name: 'Client', members: [] },
      { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:pages'] },
    ],
  });
  await view.act(async () => view.app.setActualRole(view.app.roleViewOf(roles, 'writer')));
  assert.equal(view.button(), undefined);
  assert.equal(await view.press(), false);
  assert.equal(view.count('pull'), 0);
  await view.act(async () => view.app.setActualRole(view.app.ADMIN_VIEW));
  assert.ok(view.button());
  assert.equal(view.repository.read(), 'base\n');
});

test('a check that cannot reach the remote shows no button, and the chord says so', async (context) => {
  const view = await mount(context);
  await git(view.repository.reader, ['remote', 'set-url', 'origin', path.join(view.repository.reader, 'missing.git')]);
  await view.comeBack();
  await view.until(() => view.state.incoming.kind === 'unavailable', 'the check fails');
  assert.equal(view.button(), undefined, 'no unavailable state in the title bar');
  await view.press();
  await view.until(() => view.toasts.length > 0, 'the chord answers');
  assert.match(view.toasts.at(-1)[0], /^Could not check GitHub\. Retrying automatically\./);
  assert.equal(view.toasts.at(-1)[1], 'error');
  assert.equal(view.count('pull'), 0);
});

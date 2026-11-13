// Goal: every state of the Load App From GitHub list area is a designed state,
// never bare red text. Each one (restart needed, a failure, GitHub's rate limit,
// signed out with and without a sign-in, an account with no Stacki apps)
// shows the Apps panel's empty-state pattern: a muted icon on a soft fill, a
// one-line title, a muted explanation and, where there is one, an action. In
// every state the field keeps working, so a pasted repository still gets its
// "Use owner/repo" row. A main process older than the renderer (no handler, or a
// repository list the renderer's parser refuses) reads as "restart", not as a
// parse error; GitHub's rate limit reads as its reset time.
// Method: the real RepositoryChooser rendered with react-dom/server into jsdom,
// once per list state, with "someone/thing" typed; and the real bridge
// (src/ipc/appsBridge.ts) over hand-made replies and a stubbed window.avb.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

// The components import stylesheets, which Node cannot load; React stays external so one copy renders.
function bundle(file) {
  // Inside the repository, so the bundle's `require('react')` finds node_modules.
  const directory = fs.mkdtempSync(path.join(repoPath('node_modules/.stacki-test'), 'connect-states-'));
  const output = path.join(directory, 'module.cjs');
  buildSync({
    entryPoints: [repoPath(file)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  try {
    return require(output);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { RepositoryChooser, rateLimitWait } = bundle('src/features/apps/ConnectGitHub.tsx');
const { repositoryListing, listAppRepositories } = bundle('src/ipc/appsBridge.ts');
const { ENGLISH_TRANSLATE } = bundle('shared/properties/i18n/englishTranslator.ts');

const noop = () => {};
const REPOSITORY = { owner: 'octocat', name: 'heat-map', private: false, updatedAt: '2026-11-01T00:00:00Z', stackiApp: true, organization: false };

function render(list) {
  // The scroll-edge hook uses a layout effect, which a server render skips; its warning is expected here.
  const consoleError = console.error;
  console.error = () => {};
  const markup = renderToStaticMarkup(
    React.createElement(RepositoryChooser, {
      accounts: ['octocat'],
      account: 'octocat',
      list,
      onAccount: noop,
      renderAvatar: () => React.createElement('span'),
      onPick: noop,
      initialQuery: 'someone/thing',
    }),
  );
  console.error = consoleError;
  return new JSDOM(markup).window.document;
}

// What one designed state must have, whatever it says.
function designed(document, expected) {
  const empty = document.querySelector('.apps-connect-empty');
  assert.ok(empty !== null, `${expected.title}: an empty state, not bare text`);
  assert.ok(empty.querySelector('.apps-empty-icon svg') !== null, `${expected.title}: a muted icon on its soft fill`);
  assert.equal(empty.querySelector('.apps-connect-empty-title')?.textContent, expected.title);
  assert.match(empty.querySelector('.apps-connect-empty-detail')?.textContent ?? '', expected.detail);
  const actions = [...empty.querySelectorAll('button')].map((button) => button.textContent.trim());
  assert.deepEqual(actions, expected.actions, `${expected.title}: its actions`);
  assert.ok(document.querySelector('.apps-error') === null, `${expected.title}: no bare red error text`);
  assert.equal(empty.getAttribute('role') ?? undefined, expected.alert ? 'alert' : undefined, `${expected.title}: announced only when it is a failure`);
  // The field still works: the typed repository is offered.
  assert.ok(document.querySelector('.apps-connect-field input') !== null, `${expected.title}: the field is there`);
  const use = document.querySelector('[role=option].apps-connect-use');
  assert.equal(use?.querySelector('.apps-choice-title')?.textContent, 'Use someone/thing', `${expected.title}: the Use row is offered`);
}

test('restart needed: says so, explains, and the pasted repository still works', () => {
  designed(render({ kind: 'restart' }), {
    title: 'Restart Stacki to finish updating',
    detail: /Quit it and open it again/,
    actions: [],
    alert: true,
  });
});

test('a failure: names it, shows the detail muted, and offers Retry', () => {
  designed(render({ kind: 'failed', message: 'GitHub answered 502 for this account’s repositories.', retry: noop }), {
    title: 'Couldn’t load your repositories',
    detail: /GitHub answered 502/,
    actions: ['Retry'],
    alert: true,
  });
});

test('rate limited: says GitHub is limiting requests and when to try again', () => {
  designed(render({ kind: 'rate-limited', resetAtMs: Date.now() + 2.5 * 60_000, retry: noop }), {
    title: 'GitHub is limiting requests',
    detail: /^Try again in 3 minutes\.$/,
    actions: ['Retry'],
    alert: true,
  });
  designed(render({ kind: 'rate-limited', resetAtMs: undefined, retry: noop }), {
    title: 'GitHub is limiting requests',
    detail: /^Try again in a few minutes\.$/,
    actions: ['Retry'],
    alert: true,
  });
  assert.equal(rateLimitWait(60_000, 0, ENGLISH_TRANSLATE), 'Try again in 1 minute.');
  assert.equal(rateLimitWait(0, 60_000, ENGLISH_TRANSLATE), 'Try again in 1 minute.', 'a reset already past still says a minute');
  assert.equal(rateLimitWait(10 * 60_000 + 1, 0, ENGLISH_TRANSLATE), 'Try again in 11 minutes.', 'rounded up');
});

test('signed out: the publish sign-in, or (Studio) the paste hint', () => {
  designed(render({ kind: 'signed-out', signIn: noop }), {
    title: 'Sign in with GitHub to see your repositories',
    detail: /pasted above without signing in/,
    actions: ['Sign in with GitHub'],
    alert: false,
  });
  designed(render({ kind: 'signed-out', signIn: undefined }), {
    title: 'Paste a public repository',
    detail: /owner\/repo/,
    actions: [],
    alert: false,
  });
});

test('no Stacki apps: names the account, says how to tag one, and links to how', () => {
  for (const repositories of [[], [{ ...REPOSITORY, stackiApp: false }]]) {
    const document = render({ kind: 'ready', account: 'octocat', repositories });
    designed(document, {
      title: 'No Stacki apps on octocat',
      detail: /^Add the stacki-app topic to a repository that publishes a Stacki app release\.$/,
      actions: [],
      alert: false,
    });
    const empty = document.querySelector('.apps-connect-empty');
    assert.ok(empty.querySelector('.apps-connect-empty-detail code.code-inline') !== null, 'the topic is shown as code');
    assert.equal(empty.querySelector('a')?.textContent, 'How to add it');
    assert.match(empty.querySelector('a')?.getAttribute('href') ?? '', /stacki\.build\/docs\/apps#publishing/);
    assert.equal(empty.querySelector('.apps-connect-empty-hint')?.textContent, 'or paste a repository URL above');
    assert.ok(document.querySelector('.apps-choice-list .dp-section') === null, 'no untagged list under it');
  }
});

test('a listed account shows its rows and no empty state', () => {
  const document = render({ kind: 'ready', account: 'octocat', repositories: [REPOSITORY] });
  assert.ok(document.querySelector('.apps-connect-empty') === null);
  assert.equal(document.querySelector('[role=option].apps-connect-use')?.querySelector('.apps-choice-title')?.textContent, 'Use someone/thing');
});

test('a reply the renderer refuses is a version mismatch: restart', () => {
  assert.deepEqual(repositoryListing({ ok: true, value: [REPOSITORY] }), { kind: 'ready', repositories: [REPOSITORY] });
  // The user's case: a main process from before the topic field.
  const { stackiApp: _dropped, ...older } = REPOSITORY;
  assert.deepEqual(repositoryListing({ ok: true, value: [older] }), { kind: 'restart' });
  assert.deepEqual(repositoryListing(undefined), { kind: 'restart' });
  assert.deepEqual(repositoryListing({ value: [] }), { kind: 'restart' });
});

test('a failure reply is a failure, and the rate limit carries its reset', () => {
  assert.deepEqual(repositoryListing({ ok: false, message: 'GitHub answered 502 for this account’s repositories.' }), {
    kind: 'failed',
    message: 'GitHub answered 502 for this account’s repositories.',
  });
  assert.deepEqual(repositoryListing({ ok: false, message: 'GitHub is limiting requests until 2026-11-10T15:00:00.000Z.' }), {
    kind: 'rate-limited',
    resetAtMs: Date.parse('2026-11-10T15:00:00.000Z'),
  });
  assert.deepEqual(repositoryListing({ ok: false, message: 'GitHub is limiting requests.' }), { kind: 'rate-limited', resetAtMs: undefined });
});

test('a main process without the method or the handler is a restart', async () => {
  global.window = { avb: {} };
  try {
    assert.deepEqual(await listAppRepositories('/project', 'octocat'), { kind: 'restart' });
    global.window.avb.appRepositories = async () => {
      throw new Error("Error invoking remote method 'apps:githubRepositories': Error: No handler registered for 'apps:githubRepositories'");
    };
    assert.deepEqual(await listAppRepositories('/project', 'octocat'), { kind: 'restart' });
    global.window.avb.appRepositories = async () => ({ ok: true, value: [REPOSITORY] });
    assert.deepEqual(await listAppRepositories('/project', 'octocat'), { kind: 'ready', repositories: [REPOSITORY] });
  } finally {
    delete global.window;
  }
});

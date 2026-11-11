// Goal: choosing Vercel never strands the person on a dead-end toast. No CLI offers Install
// Vercel, no login offers Sign in to Vercel (opening the sign-in dialog), an expired login offers
// Sign in again, and Refresh really re-checks: the toast leaves while it runs and comes back with
// the reason the new check found.
// Method: mount the real connections field with deferred discovery IPC and a recorded toast
// channel; resolve each check by hand and inspect the field, the toasts and the IPC calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

function load() {
  const output = repoPath('node_modules/.stacki-test/publish-connection-recovery.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { PublishConnections, connectionRecovery } from './src/features/publishing/PublishConnections';\n" +
        "export { subscribeErrorToasts } from './src/ui/errorNotices';\n",
      resolveDir: ROOT,
      loader: 'ts',
    },
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  delete require.cache[output];
  return require(output);
}

async function mount(context) {
  const code = load();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const discovery = [];
  const accounts = [];
  window.avb = {
    discoverPublishing: (input) => new Promise((resolve) => discovery.push({ ...input, resolve })),
    publishingAccount: async ({ request }) => {
      accounts.push(request);
      return { kind: 'starting' };
    },
  };
  const toasts = [];
  const unsubscribe = code.subscribeErrorToasts(
    (notice) => toasts.push({ ...notice, open: true }),
    (id) => {
      for (const toast of toasts) {
        if (toast.id === id) {
          toast.open = false;
        }
      }
    },
  );
  const root = require('react-dom/client').createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    unsubscribe();
    dom.window.close();
  });
  await act(async () =>
    root.render(
      React.createElement(code.PublishConnections, {
        // A distinct path per test keeps the module's discovery cache from crossing tests.
        projectPath: `/project/${Math.random()}`,
        provider: 'vercel',
        value: { provider: 'vercel', organizationId: '', projectId: '' },
        change() {},
      }),
    ),
  );
  const open = () => toasts.filter((toast) => toast.open);
  return { discovery, accounts, open };
}

function button(label) {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === label);
}

test('no Vercel CLI offers Install Vercel, which opens the sign-in dialog', async (context) => {
  const { discovery, accounts, open } = await mount(context);
  assert.equal(discovery[0].request.provider, 'vercel');
  await act(async () =>
    discovery[0].resolve({ kind: 'failed', reason: 'missing-cli', message: 'The Vercel command-line tool is not installed on this computer.' }),
  );
  assert.match(document.body.textContent, /not installed on this computer/);
  assert.doesNotMatch(document.body.textContent, /Connection unavailable/);
  assert.deepEqual(
    open().map((toast) => toast.recovery.map((action) => action.label)),
    [['Install Vercel']],
  );
  await act(async () => button('Install Vercel').click());
  assert.match(document.body.textContent, /Sign in to Vercel/);
  assert.equal(accounts[0].provider, 'vercel');
  assert.equal(accounts[0].action, 'start');
});

test('signed out offers Sign in to Vercel; an expired login offers Sign in again', async (context) => {
  const { discovery, open } = await mount(context);
  await act(async () => discovery[0].resolve({ kind: 'failed', reason: 'signed-out', message: 'You are not signed in to Vercel.' }));
  assert.ok(button('Sign in to Vercel'));
  assert.equal(open()[0].recovery[0].label, 'Sign in to Vercel');
  await act(async () => document.querySelector('[aria-label="Refresh hosting project"]').click());
  await act(async () => discovery[1].resolve({ kind: 'failed', reason: 'expired', message: 'Vercel sign-in expired or was revoked. Sign in again.' }));
  assert.ok(button('Sign in again'));
  assert.deepEqual(
    open().map((toast) => toast.message),
    ['Vercel sign-in expired or was revoked. Sign in again.'],
  );
});

test('Refresh re-checks, and a check that fails again reports its reason again', async (context) => {
  const { discovery, open } = await mount(context);
  const offline = { kind: 'failed', reason: 'network', message: 'Could not reach Vercel. Check your internet connection, then refresh.' };
  await act(async () => discovery[0].resolve(offline));
  assert.equal(open().length, 1);
  await act(async () => open()[0].recovery[0].run());
  assert.equal(discovery.length, 2, 'Refresh asks the provider again');
  assert.equal(open().length, 0, 'The old toast leaves while the check runs');
  assert.ok(button('Checking connection…').disabled);
  await act(async () => discovery[1].resolve(offline));
  assert.deepEqual(
    open().map((toast) => toast.message),
    [offline.message],
    'The same failure is reported again, not swallowed',
  );
  await act(async () => button('Refresh connection').click());
  await act(async () => discovery[2].resolve({ kind: 'ready', accounts: [{ id: 'team_1', name: 'Studio' }], projects: [] }));
  assert.equal(open().length, 0);
  assert.equal(button('Refresh connection'), undefined);
});

test('every failure reason has one next step', () => {
  const { connectionRecovery } = load();
  const labels = ['missing-cli', 'signed-out', 'expired', 'network', 'unknown'].map((reason) => connectionRecovery('vercel', { reason }).label);
  assert.deepEqual(labels, ['Install Vercel', 'Sign in to Vercel', 'Sign in again', 'Refresh connection', 'Refresh connection']);
  assert.equal(connectionRecovery('github', { reason: 'missing-cli' }).kind, 'refresh');
});

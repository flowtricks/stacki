// Goal: Cloudflare sign-in stays on one screen from installation to browser sign-in or failure:
// the button waits disabled while Wrangler installs, then opens the browser, and a failure turns
// it into Try again. After an install the screen says the site's dependencies changed.
// Method: render the account dialog with controlled IPC replies and advance the real poll with
// mocked timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

const browserURL = 'https://dash.cloudflare.com/oauth2/auth?state=test';

function loadDialog() {
  const output = repoPath('node_modules/.stacki-test/publish-account-install.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/publishing/PublishAccount.tsx')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  return require(output).AddPublishAccount;
}

async function render(context, reply) {
  const AddPublishAccount = loadDialog();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  window.avb = {
    publishingAccount: async ({ request }) => {
      calls.push(request);
      return reply(request);
    },
  };
  const root = require('react-dom/client').createRoot(document.getElementById('root'));
  context.after(() => dom.window.close());
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () =>
    root.render(
      React.createElement(AddPublishAccount, {
        projectPath: '/project',
        provider: 'cloudflare',
        close() {},
        connected() {},
      }),
    ),
  );
  return { calls, root };
}

function button(label) {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === label);
}

test('installation and browser sign-in share one screen', async (context) => {
  const { calls, root } = await render(context, (request) =>
    request.action === 'start' ? { kind: 'installing' } : { kind: 'browser', url: browserURL },
  );
  assert.match(document.body.textContent, /Sign in to Cloudflare/);
  assert.match(document.body.textContent, /Installing Wrangler in this site/);
  assert.match(document.body.textContent, /lets the installation finish/);
  assert.equal(button('Continue in browser').disabled, true);
  assert.doesNotMatch(document.body.textContent, /Wrangler was added/);
  await act(async () => context.mock.timers.tick(1000));
  assert.equal(button('Continue in browser').disabled, false);
  assert.match(document.body.textContent, /Wrangler was added to this site/);
  assert.match(document.body.textContent, /Waiting for sign-in/);
  assert.deepEqual(
    calls.map((call) => call.action),
    ['start', 'status'],
  );
  await act(async () => root.unmount());
  assert.equal(calls.at(-1).action, 'cancel');
  assert.equal(new Set(calls.map((call) => call.id)).size, 1);
});

test('a site that already has Wrangler says nothing about dependencies', async (context) => {
  await render(context, () => ({ kind: 'browser', url: browserURL }));
  assert.equal(button('Continue in browser').disabled, false);
  assert.doesNotMatch(document.body.textContent, /Wrangler was added/);
});

test('a failure stays on the same screen and offers Try again', async (context) => {
  const { calls } = await render(context, (request) =>
    calls.length === 1
      ? { kind: 'browser', url: browserURL }
      : request.action === 'status'
        ? { kind: 'failed', message: 'Cloudflare sign-in expired. Please try again.' }
        : { kind: 'browser', url: browserURL },
  );
  await act(async () => context.mock.timers.tick(1000));
  assert.match(document.body.textContent, /Sign in to Cloudflare/);
  assert.match(document.body.textContent, /Sign-in did not finish/);
  assert.equal(button('Continue in browser'), undefined);
  await act(async () => button('Try again').click());
  assert.equal(button('Continue in browser').disabled, false);
  const starts = calls.filter((call) => call.action === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].id, starts[1].id);
});

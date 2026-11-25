// Goal: Cloudflare sign-in stays on one screen from setup to browser sign-in or failure, with one line of text. The
// primary button carries the progress: a spinner and "Setting things up…" while the tool installs, then "Waiting for
// you in the browser…" once the sign-in page is open (opened by itself, once). A failure is a toast and the button
// turns into Try again. Nothing about tools or dependencies is ever shown, and no status paragraphs are added.
// Method: render the account dialog with controlled IPC replies, record openExternal and error toasts, and advance the
// real poll with mocked timers.
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

// One bundle for the dialog and the toast channel, so the test listens to the same toast list the dialog reports to.
function loadDialog() {
  const output = repoPath('node_modules/.stacki-test/publish-account-install.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { AddPublishAccount } from './src/features/publishing/PublishAccount';\n" + "export { subscribeErrorToasts } from './src/ui/errorNotices';\n",
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
  return require(output);
}

async function render(context, reply) {
  const code = loadDialog();
  const AddPublishAccount = code.AddPublishAccount;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  const opened = [];
  window.avb = {
    publishingAccount: async ({ request }) => {
      calls.push(request);
      return reply(request);
    },
    openExternal: async (url) => {
      opened.push(url);
      return { ok: true };
    },
  };
  const toasts = [];
  const unsubscribe = code.subscribeErrorToasts(
    (notice) => toasts.push(notice),
    () => {},
  );
  context.after(unsubscribe);
  const root = require('react-dom/client').createRoot(document.getElementById('root'));
  context.after(() => dom.window.close());
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () =>
    root.render(
      React.createElement(AddPublishAccount, {
        projectPath: '/project',
        provider: 'cloudflare',
        purpose: 'sign-in',
        close() {},
        connected() {},
      }),
    ),
  );
  return { calls, opened, toasts, root };
}

function primary() {
  return document.querySelector('.modal-body button.primary');
}

function button(label) {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === label);
}

test('setup and browser sign-in share one screen; the button carries the progress', async (context) => {
  const { calls, opened, root } = await render(context, (request) =>
    request.action === 'start' ? { kind: 'installing' } : { kind: 'browser', url: browserURL },
  );
  assert.match(document.body.textContent, /Sign in to Cloudflare/);
  assert.equal(document.querySelectorAll('.modal-body p').length, 1, 'one line of text, nothing else');
  assert.match(document.body.textContent, /Approve access in your browser/);
  assert.equal(primary().textContent, 'Setting things up…');
  assert.equal(primary().getAttribute('aria-busy'), 'true');
  assert.ok(primary().querySelector('.mini-spinner'), 'the spinner sits in the button');
  assert.equal(primary().disabled, false, 'the blue button is never dimmed by the disabled attribute');
  assert.doesNotMatch(document.body.textContent, /Wrangler|dependenc|command-line/);
  await act(async () => context.mock.timers.tick(1000));
  assert.equal(primary().textContent, 'Waiting for you in the browser…');
  assert.deepEqual(opened, [browserURL], 'the sign-in page opens by itself');
  await act(async () => context.mock.timers.tick(1000));
  assert.deepEqual(opened, [browserURL], 'and only once');
  assert.doesNotMatch(document.body.textContent, /Wrangler|dependenc/);
  assert.deepEqual(
    calls.map((call) => call.action),
    ['start', 'status', 'status'],
  );
  await act(async () => root.unmount());
  assert.equal(calls.at(-1).action, 'cancel');
  assert.equal(new Set(calls.map((call) => call.id)).size, 1);
});

test('the login switching tip lives in a (?) tip, not in the dialog text', async (context) => {
  await render(context, () => ({ kind: 'browser', url: browserURL }));
  const tip = document.querySelector('.modal-body .settings-info');
  assert.ok(tip);
  assert.match(document.getElementById(tip.getAttribute('aria-describedby')).textContent, /switch accounts in your browser/);
  assert.equal(document.querySelectorAll('.modal-body p').length, 1);
});

test('a failure is a toast and the button offers Try again', async (context) => {
  // The first status poll fails; the start before it and the retry's start after it both reach the browser step.
  let polls = 0;
  const { calls, toasts } = await render(context, (request) => {
    if (request.action === 'status') {
      polls += 1;
      if (polls === 1) {
        return { kind: 'failed', message: 'Could not finish setting up Cloudflare. Please try again.' };
      }
    }
    return { kind: 'browser', url: browserURL };
  });
  await act(async () => context.mock.timers.tick(1000));
  assert.match(document.body.textContent, /Sign in to Cloudflare/);
  assert.doesNotMatch(document.body.textContent, /Could not finish/, 'the cause is a toast, not a line in the dialog');
  assert.deepEqual(
    toasts.map((toast) => toast.message),
    ['Could not finish setting up Cloudflare. Please try again.'],
  );
  assert.equal(toasts[0].recovery[0].label, 'Try again');
  await act(async () => button('Try again').click());
  assert.equal(primary().textContent, 'Waiting for you in the browser…');
  const starts = calls.filter((call) => call.action === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].id, starts[1].id);
});

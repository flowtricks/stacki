// Goal: the Settings > Stacki Studio page has one clear hierarchy: a labelled status card that shows the installed
// version once (a newer release is one tag), at most one primary (blue) button per state, the manual command behind a
// closed "Run it yourself" disclosure, and the sign-in row as its own labelled section under the card.
// Method: mount the real StudioSetup against a fake preload bridge whose upgrade replies are deferred, then walk each
// state: checking (skeletons), not installed, blocked, up to date, update available, running, failure with Retry and
// success with the backup note. In every state count the `button.primary` elements and read the visible structure.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture.js');
const output = repoPath('node_modules/.stacki-test/studio-status-card.cjs');
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
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const StudioSetup = require(output).default;

const installed = { kind: 'installed', desktopVersion: '1.4.10', version: '1.4.10', signIn: 'github' };
const primaries = () => [...document.querySelectorAll('.studio-project-settings button.primary')].map((item) => item.textContent.trim());
const button = (label) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const statusLine = () => document.querySelector('.studio-status-card .studio-install-status');
const sectionTitles = () => [...document.querySelectorAll('.studio-project-settings .app-settings-section-header h4')].map((item) => item.textContent);

// One deferred reply per bridge call, so a test decides when each answer lands.
function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture({ status, check }) {
  globalThis.stackiCapturedToasts = [];
  const statusReply = deferred();
  const checkReply = deferred();
  const upgradeReplies = [];
  const listeners = new Set();
  window.avb = {
    studioStatus: () => statusReply.promise,
    studioUpgradeCheck: () => checkReply.promise,
    upgradeStudio: () => {
      const reply = deferred();
      upgradeReplies.push(reply);
      return reply.promise;
    },
    restoreStudio: async () => ({ kind: 'restored', version: '1.4.10' }),
    onStudioProgress: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(StudioSetup, { projectPath: '/project', previewURL: 'http://localhost:4321/' })));
  return {
    answerStatus: () => act(async () => statusReply.resolve(status)),
    answerCheck: () => act(async () => checkReply.resolve(check)),
    finishUpgrade: (reply) => act(async () => upgradeReplies.shift().resolve(reply)),
    close: () => act(async () => root.unmount()),
  };
}

test('checking shows skeletons and no button with a guessed label', async () => {
  const state = await fixture({ status: installed, check: { kind: 'current', version: '1.4.10' } });
  try {
    assert.equal(statusLine().getAttribute('aria-busy'), 'true');
    assert.ok(statusLine().querySelector('.ui-skeleton'), 'the status line is a skeleton');
    assert.equal(document.querySelectorAll('.studio-status-actions button').length, 0, 'the action is a skeleton, not a button');
    assert.deepEqual(primaries(), []);
  } finally {
    await state.close();
  }
});

test('not installed: one primary Add button, and the create command behind a closed disclosure', async () => {
  const state = await fixture({ status: { kind: 'missing', desktopVersion: '1.4.10' }, check: { kind: 'unavailable' } });
  try {
    await state.answerStatus();
    assert.deepEqual(primaries(), ['Add to project']);
    assert.equal(statusLine().textContent, 'Not installed');
    assert.deepEqual(sectionTitles(), ['Studio installation'], 'no sign-in section before Studio is installed');
    const disclosure = document.querySelector('.studio-status-card details.studio-disclosure');
    assert.equal(disclosure.open, false, 'the manual command starts closed');
    assert.match(disclosure.querySelector('summary').textContent, /Run it yourself/);
    assert.ok(disclosure.querySelector('summary svg'), 'the summary carries the shared chevron, not a raw triangle');
    assert.equal(disclosure.querySelector('.studio-install-command-box pre.code-block').textContent, 'npm create stacki@latest');
    assert.ok(button('Copy'), 'Copy is the shared secondary button');
    assert.equal(button('Copy').classList.contains('primary'), false);
  } finally {
    await state.close();
  }
});

test('blocked: one primary Review button', async () => {
  const state = await fixture({ status: { kind: 'blocked', desktopVersion: '1.4.10', message: 'Existing studio folder' }, check: { kind: 'unavailable' } });
  try {
    await state.answerStatus();
    assert.deepEqual(primaries(), ['Review Studio setup']);
    assert.equal(statusLine().dataset.state, 'blocked');
  } finally {
    await state.close();
  }
});

test('up to date: Manage is the one primary, with an Up to date tag and the sign-in section below', async () => {
  const state = await fixture({ status: installed, check: { kind: 'current', version: '1.4.10' } });
  try {
    await state.answerStatus();
    assert.ok(statusLine().querySelector('.studio-upgrade-tag-skeleton'), 'the tag is a skeleton while the check runs');
    await state.answerCheck();
    assert.deepEqual(primaries(), ['Manage Stacki Studio']);
    assert.equal(statusLine().textContent, 'Installed · 1.4.10Up to date');
    assert.deepEqual(sectionTitles(), ['Studio installation', 'Sign-in type']);
    assert.equal(document.querySelector('.studio-auth-current-name').textContent, 'GitHub');
    assert.equal(button('Change').classList.contains('primary'), false);
  } finally {
    await state.close();
  }
});

test('update available: Upgrade is the one primary, Manage turns secondary, and the version shows once', async () => {
  const state = await fixture({ status: installed, check: { kind: 'ready', installed: '1.4.10', latest: '1.4.11' } });
  try {
    await state.answerStatus();
    await state.answerCheck();
    assert.deepEqual(primaries(), ['Upgrade to 1.4.11']);
    assert.equal(button('Manage Stacki Studio').classList.contains('primary'), false);
    assert.equal(statusLine().textContent, 'Installed · 1.4.101.4.11 available');
    const text = document.querySelector('.studio-status-card').textContent;
    assert.equal(text.split('1.4.10').length - 1, 1, 'the installed version is said once');
    assert.doesNotMatch(text, /→/, 'no second "1.4.10 → 1.4.11" line');
    const command = document.querySelector('.studio-disclosure .studio-install-command-box pre.code-block').textContent;
    assert.equal(command, 'node studio/dist/cli.mjs update . 1.4.11 --replace-customizations');
  } finally {
    await state.close();
  }
});

test('running shows one progress line and no primary; failure offers Retry as the one primary; success shows the backup', async () => {
  const state = await fixture({ status: installed, check: { kind: 'ready', installed: '1.4.10', latest: '1.4.11' } });
  try {
    await state.answerStatus();
    await state.answerCheck();
    await act(async () => button('Upgrade to 1.4.11').click());
    assert.deepEqual(primaries(), []);
    assert.equal(document.querySelectorAll('.studio-upgrade-progress').length, 1);
    assert.equal(button('Manage Stacki Studio').disabled, true, 'Manage waits for the upgrade');
    await state.finishUpgrade({ kind: 'error', message: 'Download failed' });
    assert.deepEqual(primaries(), ['Retry']);
    assert.match(toastMessages(), /Download failed/);
    assert.equal(document.querySelector('.studio-status-card [role="alert"]') ?? undefined, undefined, 'the failure is a toast, not a line in the card');
    await act(async () => button('Retry').click());
    await state.finishUpgrade({
      kind: 'upgraded',
      version: '1.4.11',
      note: { from: '1.4.10', to: '1.4.11', changed: { listed: [{ kind: 'modifiedFile', path: 'studio/src/a.ts' }], total: 1 } },
    });
    assert.deepEqual(primaries(), ['Manage Stacki Studio']);
    assert.match(document.querySelector('.studio-upgrade-current').textContent, /Upgraded to 1\.4\.11/);
    const backup = [...document.querySelectorAll('.studio-disclosure summary')].map((item) => item.textContent);
    assert.ok(backup.includes('Backed up 1 changed file to .stacki/studio/updates'), 'the backup note sits behind its own disclosure');
    assert.ok(button('Restore Studio 1.4.10'));
  } finally {
    await state.close();
  }
});

test.after(() => dom.window.close());

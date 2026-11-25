// Goal: EmDash in Settings > CMS connections is a button in the CMS row, the same button as Payload and Custom CMS (same
// element, no class of its own), placed after Payload and before Custom CMS, wearing the EmDash mark. It opens a modal
// dialog (the app's Popup in modal mode: centred, backdrop, title row with the mark and a close button, focus returned to
// the button) that says what is true about the project and nothing more: skeleton rows while the first read is out; for a
// project without EmDash a short headline, one sentence, a one-line summary of what will change, a collapsed "See what will
// change" (the exact command, the files, the manual steps) and a collapsed new-site command; for a project that uses
// EmDash the content types, missing pieces and the customer-content guide. The big inline card is gone.
// Adding EmDash: nothing runs until the confirm button; the run names the command that was shown, once; it shows progress,
// live output and Cancel and cannot be closed from under; a failure says one plain sentence and lists changed files; after
// success the project is re-read and the button's mark follows. Locale catalogs hold the same keys. Failures, warnings and the
// save-first note never append a paragraph to the dialog: failures and warnings are toasts, the note is the command's (i) tip.
// Method: bundle the real CmsConnections and EmDashButton with esbuild, mount them in jsdom over a fake preload bridge
// (queued answers for `emdash:project`, `emdash:installPlan` and `emdash:install`, a recorded Cancel, a pushable log
// stream), drive the dialog with dispatched events, and read the DOM. Waits go through test/helpers/waitFor.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSameElement } = require('../../helpers/domIdentity.js');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { waitFor } = require('../../helpers/waitFor.js');
const emdash = require('#dist/shared/properties/emdash.js');

const output = repoPath('node_modules/.stacki-test/emdash-button.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: {
    contents: `export { CmsConnections } from './src/features/cmsConnections/CmsConnections';
export { EmDashButton } from './src/features/cmsConnections/EmDashButton';
export { EmDashIcon } from './src/ui/Icons';
export { subscribeErrorToasts } from './src/ui/errorNotices';`,
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const asked = [];
let answer = async () => ({ kind: 'absent' });
const READY_PLAN = {
  kind: 'ready',
  manager: 'npm',
  command: 'npm install emdash @astrojs/node @astrojs/react react react-dom --no-audit --no-fund',
  files: [
    { path: 'package.json', change: 'edit' },
    { path: 'package-lock.json', change: 'edit' },
    { path: 'astro.config.mjs', change: 'edit' },
    { path: 'src/live.config.ts', change: 'create' },
  ],
  saveFirst: false,
  warnings: [],
};
let planAnswer = async () => READY_PLAN;
let installAnswer = async () => ({ kind: 'failed', reason: 'other', changedFiles: [] });
const installs = [];
const opened = [];
let previewUrl = 'http://127.0.0.1:4321';
const cancels = [];
const logListeners = new Set();
window.avb = {
  emDashProject: async (input) => {
    asked.push(input);
    return answer();
  },
  emDashInstallPlan: async () => planAnswer(),
  emDashInstall: async (input) => {
    installs.push(input);
    return installAnswer();
  },
  emDashAdminUrl: async () => ({ url: previewUrl }),
  openExternal: async (address) => {
    opened.push(address);
    return { ok: true };
  },
  emDashInstallCancel: async (input) => {
    cancels.push(input);
    return { ok: true };
  },
  onEmDashInstallLog: (callback) => {
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  },
  cmsConnections: async () => ({ encryption: 'available', connections: [] }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

const schema = JSON.parse(fs.readFileSync(repoPath('test/fixtures/emdash/site/.emdash/schema.json'), 'utf8'));
const PRESENT = {
  kind: 'present',
  configFile: 'astro.config.mjs',
  output: 'server',
  databaseFile: 'data.db',
  schemaSource: 'database',
  collections: emdash.parseEmDashSchema(schema).value,
  problems: ['uploadsTracked'],
};

let root;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = () => document.querySelector('button[data-cms="emdash"]');
const popup = () => document.querySelector('dialog .emdash-dialog');
const dialogElement = () => document.querySelector('dialog[data-popup="modal"]');
const event = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const pressBackdrop = () =>
  act(async () => {
    const target = dialogElement();
    target.dispatchEvent(event('pointerdown'));
    target.dispatchEvent(event('mousedown'));
    target.dispatchEvent(event('click'));
  });
const pressButton = (selector) => act(async () => popup().querySelector(selector).dispatchEvent(event('click')));
const buttonNamed = (name) => [...popup().querySelectorAll('button')].find((item) => item.textContent.trim() === name);
const pushLog = (text) => act(async () => [...logListeners].forEach((listener) => listener(text)));
const click = () => act(async () => button().dispatchEvent(event('click')));
const popupGone = (what) => waitFor({ what, read: () => popup() === null, until: Boolean });
const popupShown = (what) => waitFor({ what, read: () => popup() !== null, until: Boolean });

async function mount(element) {
  asked.length = 0;
  installs.length = 0;
  opened.length = 0;
  previewUrl = 'http://127.0.0.1:4321';
  cancels.length = 0;
  logListeners.clear();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  await settle();
}

const mountRow = async () => {
  await mount(React.createElement(component.CmsConnections, { projectPath: '/project' }));
};
// Every toast the app raised, in order: the dialog's failures and warnings are said there, never as a paragraph in the dialog.
const toasts = [];
let unsubscribe;
test.beforeEach(() => {
  toasts.length = 0;
  unsubscribe?.();
  unsubscribe = component.subscribeErrorToasts(
    (notice) => toasts.push(notice),
    () => undefined,
  );
  answer = async () => ({ kind: 'absent' });
  planAnswer = async () => READY_PLAN;
  installAnswer = async () => ({ kind: 'failed', reason: 'other', changedFiles: [] });
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});
const openDialog = async () => {
  await click();
  await popupShown('the dialog opens');
  await settle();
};
// The dialog with everything it reads on screen: no skeleton left.
const openLoaded = async () => {
  await openDialog();
  await waitFor({ what: 'the dialog has what it reads', read: () => popup().querySelectorAll('.ui-skeleton-rows').length, until: (count) => count === 0 });
};
const detailsNamed = (name) => [...popup().querySelectorAll('details')].find((item) => item.querySelector('summary').textContent.trim() === name);

test('EmDash is a button in the CMS row, after Payload and before Custom CMS, with the same markup as them', async () => {
  await mountRow();
  const row = [...document.querySelectorAll('.cms-connection-actions > button, .cms-connection-actions > * > button')];
  assert.deepEqual(row.map((item) => item.textContent.trim()).slice(-3), ['Payload', 'EmDash', 'Custom CMS']);
  const payload = row.find((item) => item.textContent.trim() === 'Payload');
  assert.equal(button().parentElement, payload.parentElement, 'a direct child of the same row');
  assert.equal(button().getAttribute('class'), payload.getAttribute('class'), 'no class of its own: the shared button styling');
  assert.equal(button().querySelector('svg').getAttribute('width'), payload.querySelector('svg').getAttribute('width'), 'the same icon size');
  assert.equal(button().getAttribute('aria-haspopup'), 'dialog');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('the inline EmDash card is gone, and nothing shows until the button is pressed', async () => {
  answer = async () => PRESENT;
  await mountRow();
  assert.ok(document.querySelector('.emdash-card') === null);
  assert.ok(popup() === null);
  assert.doesNotMatch(document.body.textContent, /EmDash is not set up/);
});

test('the logo is the supplied mark: path and group shapes in currentColor, nothing that runs or loads', async () => {
  await mountRow();
  const svg = button().querySelector('svg');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const allowed = new Set(['svg', 'g', 'path']);
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    assert.ok(allowed.has(element.tagName.toLowerCase()), `only shapes: found <${element.tagName}>`);
    for (const attribute of element.getAttributeNames()) {
      assert.doesNotMatch(attribute, /^(on|href|xlink)/i, `no handler or reference: ${attribute}`);
      assert.doesNotMatch(element.getAttribute(attribute), /url\(|javascript:|https?:/i, `no external reference in ${attribute}`);
    }
  }
  assert.equal(svg.querySelectorAll('path').length, 2, 'the frame and the dash');
  assert.equal(svg.querySelector('g').getAttribute('fill'), 'currentColor');
  assert.match(svg.querySelectorAll('path')[1].getAttribute('d'), /^M28\.2598 53\.3799H90\.0645V63\.6807H28\.2598V53\.3799Z$/);
});

test('the dialog is a modal: centred native dialog, title row with the mark and a close button, and it closes every way', async () => {
  await mountRow();
  await openDialog();
  assert.equal(dialogElement().getAttribute('role'), 'dialog');
  assert.equal(dialogElement().getAttribute('aria-label'), 'EmDash');
  assert.equal(dialogElement().open, true, 'opened as a modal, so the browser traps focus and dims the page');
  assert.ok(popup().querySelector('.modal-header svg'), 'the mark is in the title row');
  assert.match(popup().querySelector('.modal-header h4').textContent, /^EmDash$/);
  assert.equal(button().getAttribute('aria-expanded'), 'true', 'the button says its dialog is open');
  // The close button.
  await pressButton('.emdash-dialog-close');
  await popupGone('the close button closes it');
  assertSameElement(document.activeElement, button(), 'focus is back on the button');
  // Escape.
  await click();
  await popupShown('it opens again');
  await act(async () => key(document, 'Escape'));
  await popupGone('Escape closes it');
  assertSameElement(document.activeElement, button());
  // A press on the backdrop.
  await click();
  await popupShown('it opens a third time');
  await pressBackdrop();
  await popupGone('a backdrop press closes it');
  assertSameElement(document.activeElement, button());
});

test('while the project is read the dialog shows skeleton rows, not words', async () => {
  answer = () => new Promise(() => undefined);
  await mountRow();
  await openDialog();
  assert.equal(popup().querySelector('.ui-skeleton-rows').getAttribute('aria-busy'), 'true');
  assert.ok(popup().querySelector('.ui-skeleton-rows').nextElementSibling === null, 'no placeholder words beside the skeleton');
  assert.ok(button().querySelector('.cms-connect-status') === null, 'no connected mark before it is known');
});

test('not set up: a headline, one sentence, a one-line summary, the details collapsed, and no wall of text', async () => {
  await mountRow();
  assert.deepEqual(asked, [{ projectPath: '/project' }]);
  await openLoaded();
  const text = popup().querySelector('.modal-body').textContent;
  assert.match(text, /EmDash is not set up in this project/);
  assert.match(text, /Add the CMS to this project without starting over\./);
  assert.match(text, /Files: 4 · runs npm/);
  assert.doesNotMatch(text, /Stacki finds EmDash from the project itself/, 'the long explanation is gone');
  assert.equal(detailsNamed('See what will change').open, false, 'the details start collapsed');
  assert.doesNotMatch(popup().textContent, /new site|npm create emdash/, 'no new-site option in this dialog');
  assert.equal(buttonNamed('Add EmDash to this project').className, 'primary', 'one primary action');
  assert.ok(buttonNamed('Cancel'), 'and a secondary Cancel');
  assert.equal(installs.length, 0, 'opening runs nothing');
});

test('See what will change shows the exact command, the files as pills, and the manual steps as a short checklist', async () => {
  await mountRow();
  await openLoaded();
  const details = detailsNamed('See what will change');
  assert.equal(details.querySelector('pre').textContent, READY_PLAN.command, 'the exact command that will run');
  assert.ok(details.querySelector('.emdash-code-copy'), 'with a copy button');
  const files = [...details.querySelectorAll('.emdash-install-files li')].map((item) => [
    item.querySelector('code').textContent,
    item.querySelector('.emdash-pill').textContent,
  ]);
  assert.deepEqual(files, [
    ['package.json', 'changed'],
    ['package-lock.json', 'changed'],
    ['astro.config.mjs', 'changed'],
    ['src/live.config.ts', 'new'],
  ]);
  assert.equal(details.querySelector('.emdash-install-files code').getAttribute('title'), 'package.json', 'the full name is the tooltip');
  assert.ok(details.querySelector('.emdash-install-steps') === null, 'no manual steps: Stacki does them');
});

test('a project with unsaved work says it will be saved first, in one plain line, and a clean one says nothing', async () => {
  planAnswer = async () => ({ ...READY_PLAN, saveFirst: true });
  await mountRow();
  await openLoaded();
  assert.match(popup().querySelector('.emdash-install-summary').textContent, /Saves your changes · files: 4/, 'the one-line summary says so');
  assert.ok(popup().querySelector('.emdash-install > .emdash-install-note') === null, 'no extra line outside the disclosure');
  assert.equal(detailsNamed('See what will change').firstElementChild.nextElementSibling.className, 'emdash-more-body');
  assert.ok(detailsNamed('See what will change').querySelector('.emdash-install-note') === null, 'the note is not a paragraph');
  assert.match(
    detailsNamed('See what will change').querySelector('.emdash-more-body h6 .info-hint-text').textContent,
    /Saves your current changes first, as a commit called “Before Adding EmDash”/,
    'it is the command heading’s (i) tip',
  );
  assert.equal(buttonNamed('Add EmDash to this project').disabled, false);
  await act(async () => key(document, 'Escape'));
  await popupGone('closed');
  planAnswer = async () => READY_PLAN;
  await openLoaded();
  assert.ok(popup().querySelector('.emdash-more-body h6 .info-hint-text') === null, 'a clean tree has no such tip');
  assert.match(popup().querySelector('.emdash-install-summary').textContent, /^Files: 4 · runs npm$/);
});

test('another adapter is a warning toast, not a line in the dialog', async () => {
  planAnswer = async () => ({ ...READY_PLAN, warnings: ['otherAdapter'] });
  await mountRow();
  await openLoaded();
  assert.ok(popup().querySelector('.emdash-install-warning') === null, 'nothing is appended to the dialog');
  const warnings = toasts.filter((notice) => notice.kind === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /You already use another adapter/);
});

test('a failed save names itself and installs nothing', async () => {
  installAnswer = async () => ({ kind: 'failed', reason: 'saveFailed', changedFiles: [] });
  await mountRow();
  await openLoaded();
  await act(async () => buttonNamed('Add EmDash to this project').dispatchEvent(event('click')));
  await settle();
  assert.ok(popup().querySelector('.emdash-install-problem') === null, 'no paragraph in the dialog');
  assert.match(toasts.at(-1).message, /Could not save your changes first, so nothing was installed\./);
  assert.equal(toasts.at(-1).kind, 'error');
  assert.ok(buttonNamed('Try again'));
});

test('nothing runs without the confirm click: Cancel and closing leave the project alone', async () => {
  await mountRow();
  await openLoaded();
  await act(async () => buttonNamed('Cancel').dispatchEvent(event('click')));
  await popupGone('Cancel closes the dialog');
  assert.equal(installs.length, 0);
  assert.equal(cancels.length, 0);
});

test('confirming runs the command that was shown, once, with progress, live output and Cancel; the dialog cannot be closed meanwhile', async () => {
  let finish;
  installAnswer = () => new Promise((resolve) => (finish = resolve));
  await mountRow();
  await openLoaded();
  await act(async () => buttonNamed('Add EmDash to this project').dispatchEvent(event('click')));
  await act(async () => buttonNamed('Add EmDash to this project')?.dispatchEvent(event('click')));
  assert.deepEqual(installs, [{ projectPath: '/project', confirmedCommand: READY_PLAN.command }], 'one run, naming the command shown');
  assert.ok(popup().querySelector('.progress-ring'), 'a progress ring');
  assert.ok(popup().querySelector('.progress-ring-turning'), 'turning, because the length is unknown');
  assert.match(popup().querySelector('[role="status"]').textContent, /Installing packages…/);
  assert.match(popup().querySelector('.emdash-install-heading').textContent, /^Adding EmDash$/, 'the heading names the state, not the one before');
  await pushLog('added 1 package\n');
  await waitFor({
    what: 'the output shows live',
    read: () => popup().querySelector('.emdash-install-log pre').textContent,
    until: (value) => /added 1 package/.test(value),
  });
  assert.equal(popup().querySelector('.emdash-dialog-close').disabled, true, 'the close button is off');
  await act(async () => key(document, 'Escape'));
  assert.ok(popup() !== null, 'Escape does not close it');
  await pressBackdrop();
  assert.ok(popup() !== null, 'nor does the backdrop');
  await act(async () => buttonNamed('Cancel').dispatchEvent(event('click')));
  assert.deepEqual(cancels, [{ projectPath: '/project' }]);
  assert.match(popup().querySelector('[role="status"]').textContent, /Stopping…/);
  await act(async () => finish({ kind: 'cancelled', changedFiles: ['package.json'] }));
  await settle();
  assert.match(popup().querySelector('.emdash-install-heading').textContent, /Adding EmDash was cancelled/);
  assert.match(popup().textContent, /Changed files \(1\)/);
  assert.match(popup().textContent, /Nothing was reverted\./);
  assert.equal(popup().querySelector('.emdash-dialog-close').disabled, false);
});

test('a failure is one plain sentence with the log behind a disclosure, the changed files, and a way to try again', async () => {
  installAnswer = async () => ({ kind: 'failed', reason: 'noNetwork', changedFiles: [] });
  await mountRow();
  await openLoaded();
  await act(async () => buttonNamed('Add EmDash to this project').dispatchEvent(event('click')));
  await settle();
  assert.ok(popup().querySelector('.emdash-install-problem') === null, 'no paragraph in the dialog');
  assert.match(toasts.at(-1).message, /Could not reach the package registry\. Check your connection\./);
  assert.match(popup().textContent, /No files changed\./);
  assert.equal(detailsNamed('Show log').open, false);
  await act(async () => buttonNamed('Try again').dispatchEvent(event('click')));
  assert.ok(buttonNamed('Add EmDash to this project'), 'back at the preview');
});

test('success: a short header, a tight checklist, one primary button, and everything else behind one Details', async () => {
  installAnswer = async () => ({
    kind: 'installed',
    complete: true,
    saved: true,
    keyGenerated: true,
    databaseReady: true,
    preview: 'running',
    adminUrl: 'http://127.0.0.1:4321/_emdash/admin/',
    config: 'merged',
    onDemand: true,
    project: PRESENT,
    changedFiles: ['package.json', 'src/live.config.ts'],
    manual: [],
  });
  await mountRow();
  assert.ok(button().querySelector('.cms-connect-status') === null);
  await openLoaded();
  await act(async () => buttonNamed('Add EmDash to this project').dispatchEvent(event('click')));
  await settle();
  assert.ok(button().querySelector('.cms-connect-status'), 'the button’s mark follows');
  assert.equal(popup().querySelector('.emdash-install-heading').textContent, 'EmDash is ready');
  const ticks = [...popup().querySelectorAll('.emdash-checklist > li')].map((item) => [item.getAttribute('data-done'), item.textContent.trim()]);
  assert.deepEqual(ticks, [
    ['true', 'EmDash installed'],
    ['true', 'Astro config updated'],
    ['true', 'Local key created'],
    ['true', 'Database ready'],
  ]);
  const primary = [...popup().querySelectorAll('button.primary')];
  assert.deepEqual(
    primary.map((item) => item.textContent.trim()),
    ['Open EmDash setup'],
    'one primary button',
  );
  assert.equal(popup().querySelectorAll(':scope .emdash-install > details').length, 1, 'one disclosure at the top level');
  assert.equal(detailsNamed('Details').open, false, 'collapsed by default');
  const details = detailsNamed('Details').textContent;
  assert.match(details, /saved as “Before Adding EmDash” in History/);
  assert.match(details, /Your site now renders pages on request\./);
  assert.match(details, /Changed files \(2\)/);
  assert.ok(detailsNamed('Details').querySelector('.emdash-collection'), 'the content types are in Details');
  assert.equal(toasts.filter((notice) => notice.kind === 'warning').length, 0, 'no warning when nothing needs doing');
  assert.doesNotMatch(popup().textContent.replace(details, ''), /dev server|Run the dev server|run the dev server/i);
  await act(async () => primary[0].dispatchEvent(event('click')));
  assert.deepEqual(opened, ['http://127.0.0.1:4321/_emdash/admin/'], 'opens the admin on the preview’s own address');
});

test('success that still needs the config: the remaining steps are named, never called done', async () => {
  const unwired = { ...PRESENT, problems: ['noIntegration'] };
  installAnswer = async () => ({
    kind: 'installed',
    complete: false,
    saved: false,
    keyGenerated: false,
    databaseReady: false,
    preview: 'failed',
    adminUrl: undefined,
    config: 'otherAdapter',
    onDemand: false,
    project: unwired,
    changedFiles: ['package.json'],
    manual: ['astroConfig'],
  });
  await mountRow();
  await openLoaded();
  await act(async () => buttonNamed('Add EmDash to this project').dispatchEvent(event('click')));
  await settle();
  assert.match(popup().textContent, /Packages installed\. Still to do:/);
  assert.doesNotMatch(popup().textContent, /EmDash is ready/);
  assert.ok(popup().querySelector('.emdash-install-warning') === null, 'nothing is appended to the dialog');
  assert.match(toasts.at(-1).message, /The preview did not restart\. Reopen the project\./, 'one warning toast');
  assert.equal(toasts.at(-1).kind, 'warning');
  assert.ok(buttonNamed('Open EmDash setup') === undefined, 'no admin button without a preview that answered');
  const pending = [...popup().querySelectorAll('.emdash-checklist > li[data-done="false"]')].map((item) => item.textContent.trim());
  assert.ok(
    pending.some((text) => /different adapter, so Stacki left it/.test(text)),
    'the config step is still ahead, with the reason',
  );
  assert.ok(popup().querySelector('.emdash-checklist details pre'), 'with its code one disclosure away');
  assert.doesNotMatch(popup().textContent, /saved as “Before Adding EmDash”/, 'no note when nothing was saved');
  assert.match(popup().textContent, /Add the emdash\(\) integration/, 'detection still lists the missing integration');
});

test('a plan that cannot be made says why in a toast and offers no way to run', async () => {
  planAnswer = async () => ({ kind: 'unavailable', reason: 'astroTooOld' });
  await mountRow();
  await openLoaded();
  assert.ok(popup().querySelector('.emdash-install-problem') === null, 'no paragraph in the dialog');
  assert.match(toasts.at(-1).message, /EmDash needs Astro 6 or later\./);
  assert.ok(buttonNamed('Add EmDash to this project') === undefined);
});

test('a project that uses EmDash shows the connected mark and lists its content types exactly as EmDash defines them', async () => {
  answer = async () => PRESENT;
  await mountRow();
  assert.equal(button().querySelector('.cms-connect-status').getAttribute('aria-label'), 'Set up');
  await openLoaded();
  const names = [...popup().querySelectorAll('.emdash-collection > summary')].map((node) => node.firstChild.textContent);
  assert.deepEqual(names, ['Posts', 'Case studies']);
  const rows = [...popup().querySelectorAll('.emdash-collection')[0].querySelectorAll('.emdash-field')].map((row) => row.textContent);
  assert.ok(rows.some((row) => /Title.*title.*required.*Text/.test(row)));
  assert.ok(rows.some((row) => /Featured Image.*featured_image.*Image/.test(row)));
  assert.ok(rows.some((row) => /Layout hint.*Unknown type/.test(row)));
  assert.match(popup().querySelector('.emdash-status-line').textContent, /^2 content types · data\.db · when requested \(server\)$/);
  assert.ok(popup().querySelector('.emdash-facts') === null, 'the key/value table is gone');
  assert.equal(detailsNamed('Details').open, false, 'the notes and the guide are behind Details');
  assert.ok(buttonNamed('Open EmDash admin'), 'the admin opens from one primary button');
  await act(async () => buttonNamed('Open EmDash admin').dispatchEvent(event('click')));
  assert.deepEqual(opened, ['http://127.0.0.1:4321/_emdash/admin/']);
  assert.match(popup().textContent, /uploads folder is not in \.gitignore/);
  assert.equal(popup().querySelectorAll('input, textarea, select').length, 0, 'nothing here edits a content type');
  assert.ok(popup().querySelector('.emdash-install') === null, 'no install section for a project that has EmDash');
});

test('without a running preview there is no admin button, and the status line is the only summary', async () => {
  answer = async () => PRESENT;
  await mountRow();
  previewUrl = undefined;
  await openLoaded();
  assert.ok(buttonNamed('Open EmDash admin') === undefined);
  assert.ok(popup().querySelector('.emdash-status-line'));
});

test('the guide shows the EmDash commands for copying a customer site', async () => {
  answer = async () => PRESENT;
  await mountRow();
  await openLoaded();
  const commands = [...popup().querySelectorAll('.emdash-guide pre')].map((node) => node.textContent);
  assert.deepEqual(commands, [
    'npx emdash login --url https://customer-site.example',
    'npx emdash site export --url https://customer-site.example --output customer.emdash',
    'npx emdash site import customer.emdash --analyze',
    'npx emdash site import customer.emdash --plan <digest> --confirm',
  ]);
});

test('a read that fails shows the project as not set up rather than an error', async () => {
  answer = async () => {
    throw new Error('bridge down');
  };
  await mountRow();
  await openLoaded();
  assert.match(popup().textContent, /EmDash is not set up in this project/);
});

test('every locale holds the same EmDash keys, and the ones this dialog uses', () => {
  const keysOf = (locale) => {
    const source = fs.readFileSync(repoPath(`shared/properties/i18n/messages/${locale}/emdash.ts`), 'utf8');
    return [...source.matchAll(/^ {2}'(emdash\.[^']+)':/gm)].map((match) => match[1]).sort();
  };
  const english = keysOf('en');
  for (const key of [
    'emdash.install.confirm',
    'emdash.install.summary',
    'emdash.install.details',
    'emdash.install.copy',
    'emdash.install.saveFirst',
    'emdash.install.failure.saveFailed',
    'emdash.button.connected',
  ]) {
    assert.ok(english.includes(key), `en has ${key}`);
  }
  for (const gone of ['emdash.absent.hint', 'emdash.absent.create', 'emdash.absent.newSite', 'emdash.install.warning.uncommittedChanges']) {
    assert.ok(!english.includes(gone), `${gone} is removed`);
  }
  // Every catalog directory; the catalog-parity test ties the directories to the locale list.
  const directories = fs
    .readdirSync(repoPath('shared/properties/i18n/messages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(directories.length >= 18);
  for (const locale of directories.filter((name) => name !== 'en')) {
    assert.deepEqual(keysOf(locale), english, `${locale} has the same keys as en`);
  }
});

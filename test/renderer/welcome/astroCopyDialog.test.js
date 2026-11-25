// "Open from folder" on a plain website folder, and the "Make an Astro copy" dialog it opens.
//
//   node test/renderer/welcome/astroCopyDialog.test.js
//
// Goal: the dialog starts filled in (the folder's name with -astro, the folder's parent shown from home),
// enables "Create copy" only once main has checked those values, refuses bad values with the error look and
// one toast on submit (never a text row under the field), keeps focus in the field after an error, submits on
// Enter, shows its progress in the button while the copy runs, and on failure says why in a toast and lets the
// person try again. On the Welcome screen, an Astro folder opens, a plain website opens this dialog, and a
// folder that is neither is a toast.
//
// Method: the real WelcomeScreen and AstroCopyDialog, bundled once with the toast channel so the test hears
// every toast, rendered in jsdom over a fake preload bridge (window.avb) whose replies the test scripts and,
// for the copy itself, holds until it releases them. Every wait polls the DOM (test/helpers/waitFor.js); none
// is a fixed pause.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const PLATFORM_NULL = JSON.parse('null');

const ENTRY = `
export { default as WelcomeScreen } from ${JSON.stringify(repoPath('src/features/welcome/WelcomeScreen.tsx'))};
export { default as AstroCopyDialog } from ${JSON.stringify(repoPath('src/features/welcome/AstroCopyDialog.tsx'))};
export { subscribeErrorToasts } from ${JSON.stringify(repoPath('src/ui/errorNotices.ts'))};
`;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'astroCopyDialog.bundle.js');
  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: repoPath('.'), loader: 'ts', sourcefile: 'entry.ts' },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.navigator = dom.window.navigator;
  // Renders happen as the fake bridge answers; the test waits on the DOM instead of wrapping them in act.
  global.IS_REACT_ACT_ENVIRONMENT = false;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => PLATFORM_NULL;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext = function WebGLRenderingContext() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { WelcomeScreen, AstroCopyDialog, subscribeErrorToasts } = require(bundlePath);

  const toasts = [];
  subscribeErrorToasts(
    (notice) => toasts.push(notice.message),
    () => {},
  );
  const until = (what, read, holds = (value) => Boolean(value)) => waitFor({ what, read, until: holds });
  const container = dom.window.document.getElementById('root');
  const modal = () => dom.window.document.querySelector('.astro-copy-modal');
  const input = () => modal()?.querySelector('input');
  const create = () => [...(modal()?.querySelectorAll('.modal-footer button') ?? [])].find((button) => button.classList.contains('primary'));
  const location = () => modal()?.querySelector('.astro-copy-location');
  const type = (value) => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const enter = () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  // The fake main process: target checks answer from `verdicts` (by name), the copy waits for `release`.
  const checks = [];
  const verdicts = new Map([['taken', { ok: false, error: 'target-exists' }]]);
  let locationVerdict;
  const copies = [];
  let release;
  const created = {
    projectPath: '/Users/me/Sites/shop-astro',
    pageCount: 3,
    assetCount: 4,
    keptAsFiles: ['_partial.html'],
    keptAsFilesCount: 1,
    skippedCount: 0,
    install: { kind: 'done' },
  };
  dom.window.avb = {
    onCreateLog: () => () => {},
    // The window drop's inbox (src/features/welcome/FolderDropHost.tsx): nothing handed over.
    takeOpenedFolders: async () => [],
    onFolderOpened: () => () => {},
    checkAstroCopy: async (request) => {
      checks.push(request);
      return locationVerdict ?? verdicts.get(request.name) ?? { ok: true, value: { targetPath: `${request.parentPath}/${request.name}` } };
    },
    createAstroCopy: (request) => {
      copies.push(request);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    parentDialog: async () => ({ canceled: false, parentPath: '/Volumes/Work/clients/acme/sites' }),
    listRecents: async () => [],
  };

  // The dialog on its own.
  const done = [];
  const root = createRoot(container);
  root.render(
    React.createElement(AstroCopyDialog, {
      source: { sourcePath: '/Users/me/Sites/shop', parentPath: '/Users/me/Sites', name: 'shop-astro', homePath: '/Users/me' },
      onClose: () => {},
      onDone: (value) => done.push(value),
    }),
  );
  await until('the dialog', modal);
  check('titled Make an Astro copy', modal().querySelector('.modal-header')?.textContent === 'Make an Astro copy', modal().textContent.slice(0, 80));
  check(
    'with its one line saying the original stays untouched',
    modal().querySelector('.starter-note')?.textContent === 'Stacki makes an Astro copy and leaves your original folder untouched.',
  );
  check('the name defaults to the folder name with -astro', input().value === 'shop-astro', input().value);
  check('the location is shown from home', location().querySelector('.code-inline')?.textContent === '~/Sites', location().textContent);
  check('as highlighted code', location().querySelector('.code-inline') !== null);
  check('with the full path as its tooltip', location().getAttribute('title') === '/Users/me/Sites');
  check('the field has focus', dom.window.document.activeElement === input());
  await until('the check of the defaults', () => !create().disabled);
  check('Create copy is enabled once main checked the defaults', !create().disabled && create().textContent === 'Create copy');
  check(
    'the check named the original, the location and the name',
    JSON.stringify(checks[0]) === JSON.stringify({ sourcePath: '/Users/me/Sites/shop', parentPath: '/Users/me/Sites', name: 'shop-astro' }),
  );
  const bodyText = () => modal().querySelector('.modal-body').textContent;
  const bodyBefore = modal().querySelector('.modal-body').children.length;

  // A bad name: refused here at once, without asking main, and explained only on submit.
  const checksBefore = checks.length;
  type('a:b');
  await until('the invalid look', () => input().getAttribute('aria-invalid') === 'true');
  check('Create copy is disabled for a bad name', create().disabled);
  check('a bad name is not sent to main', checks.length === checksBefore, String(checks.length - checksBefore));
  check('nothing is toasted while typing', toasts.length === 0, JSON.stringify(toasts));
  enter();
  await until('the toast', () => toasts.length === 1);
  check('Enter on a bad name toasts why', /A folder can’t have that name/.test(toasts[0] ?? ''), toasts[0]);
  check('and focus stays in the field', dom.window.document.activeElement === input());
  check(
    'no text row is added under the field',
    modal().querySelector('.modal-body').children.length === bodyBefore && !bodyText().includes('can’t have that name'),
  );
  enter();
  await until('a second toast', () => toasts.length === 2);
  check('every submit attempt toasts once', toasts.length === 2);
  type('');
  await until('the empty look', () => input().getAttribute('aria-invalid') === 'true' && create().disabled);
  enter();
  await until('the empty toast', () => toasts.length === 3);
  check('an empty name says to give it one', toasts[2] === 'Give the copy a name.', toasts[2]);

  // A name main refuses: the folder is already there.
  type('taken');
  await until('main to refuse the name', () => input().getAttribute('aria-invalid') === 'true' && checks.some((request) => request.name === 'taken'));
  check('a taken name takes the error look and disables Create copy', create().disabled);
  enter();
  await until('the taken toast', () => toasts.length === 4);
  check('Enter says the folder is already there', /already there/.test(toasts[3] ?? ''), toasts[3]);

  // A location main refuses: the location row takes the look, the name does not.
  locationVerdict = { ok: false, error: 'location-unwritable' };
  type('shop-astro');
  await until('the location look', () => location().getAttribute('aria-invalid') === 'true');
  check('an unwritable location marks the location row, not the name', input().getAttribute('aria-invalid') === null);
  locationVerdict = undefined;

  // Choose… uses the native folder picker and checks again.
  modal().querySelector('.astro-copy-location button').click();
  await until('the new location', () => location().querySelector('.code-inline')?.textContent === '…/clients/acme/sites');
  await until('the check of the new location', () => !create().disabled);
  check('Choose… re-checks the new place', checks.at(-1)?.parentPath === '/Volumes/Work/clients/acme/sites', JSON.stringify(checks.at(-1)));
  check('the location row is no longer refused', location().getAttribute('aria-invalid') === null);

  // Enter submits; the copy runs with its progress in the button, then fails and can be tried again.
  enter();
  await until('the copy to start', () => copies.length === 1 && create().textContent === 'Creating copy…');
  check(
    'the copy is asked for the chosen values',
    JSON.stringify(copies[0]) === JSON.stringify({ sourcePath: '/Users/me/Sites/shop', parentPath: '/Volumes/Work/clients/acme/sites', name: 'shop-astro' }),
  );
  check('while it runs the button and the field are disabled', create().disabled && input().disabled);
  check('and the button says so', create().getAttribute('aria-busy') === 'true');
  enter();
  check('Enter while it runs does not start a second copy', copies.length === 1);
  const toastsBefore = toasts.length;
  release({ ok: false, error: { code: 'copy-failed', detail: 'ENOSPC: no space left on device' } });
  await until('the failure toast', () => toasts.length === toastsBefore + 1);
  check('a failed copy is one toast naming why', /nothing was left behind: ENOSPC/.test(toasts.at(-1) ?? ''), toasts.at(-1));
  await until('the dialog to be ready again', () => !input().disabled && !create().disabled);
  check('focus is back in the field', dom.window.document.activeElement === input());
  check('the failure is not written into the dialog', !bodyText().includes('ENOSPC'));

  // A second try succeeds and hands the project to the screen.
  create().click();
  await until('the second copy', () => copies.length === 2);
  release({ ok: true, value: created });
  await until('the dialog to finish', () => done.length === 1);
  check('success hands over the made project', done[0]?.projectPath === '/Users/me/Sites/shop-astro');
  root.unmount();

  // The Welcome screen: what "Open from folder" does with each kind of folder.
  const opened = [];
  const shown = [];
  const screen = createRoot(container);
  screen.render(
    React.createElement(WelcomeScreen, { onOpen: (projectPath) => opened.push(projectPath), showToast: (message, kind) => shown.push({ message, kind }) }),
  );
  await until('the welcome screen', () => container.querySelector('.actions button'));
  const openFromFolder = () => container.querySelectorAll('.actions button')[0];

  dom.window.avb.openSiteDialog = async () => ({ kind: 'astro', projectPath: '/Users/me/Sites/blog' });
  openFromFolder().click();
  await until('an Astro project to open', () => opened.length === 1);
  check('an Astro folder opens as before', opened[0] === '/Users/me/Sites/blog' && modal() === null);

  const toastsBeforeNeither = toasts.length;
  dom.window.avb.openSiteDialog = async () => ({ kind: 'notWebsite', folderPath: '/Users/me/Documents' });
  openFromFolder().click();
  await until('the not-a-website toast', () => toasts.length === toastsBeforeNeither + 1);
  check('a folder that is neither is a toast', /isn’t a website/.test(toasts.at(-1) ?? ''), toasts.at(-1));
  check('and opens nothing', opened.length === 1 && modal() === null);

  dom.window.avb.openSiteDialog = async () => ({
    kind: 'plainWebsite',
    sourcePath: '/Users/me/Sites/shop',
    parentPath: '/Users/me/Sites',
    name: 'shop-astro',
    homePath: '/Users/me',
  });
  openFromFolder().click();
  await until('the copy dialog', () => modal() && !create()?.disabled);
  check('a plain website opens the copy dialog with its defaults', input().value === 'shop-astro');
  enter();
  await until('the third copy', () => copies.length === 3);
  release({ ok: true, value: { ...created, install: { kind: 'failed', detail: 'offline' } } });
  await until('the copy to open', () => opened.length === 2);
  check('the made copy opens', opened[1] === '/Users/me/Sites/shop-astro' && modal() === null);
  check(
    'with a success toast',
    shown.some((toast) => toast.kind === 'success' && toast.message === 'Astro copy created'),
    JSON.stringify(shown),
  );
  check(
    'a page kept as a plain file is said in a toast',
    shown.some((toast) => toast.kind === 'info' && toast.message === '1 page stays a plain HTML file so its address keeps working: _partial.html'),
    JSON.stringify(shown),
  );
  check(
    'and a failed install is an error toast, the copy still opening',
    shown.some((toast) => toast.kind === 'error' && /didn’t install: offline/.test(toast.message)),
    JSON.stringify(shown),
  );
  screen.unmount();

  if (failures.length) {
    console.error(`\nastro-copy-dialog: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`astro-copy-dialog: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

// A picked folder with websites inside it: what the person sees and what opens.
//
//   node test/renderer/welcome/nestedSitesDialog.test.js
//
// Goal: one website inside is said where it is and opens only on its button; several are listed by where they are
// and the one chosen opens; Cancel and Escape open nothing; the picked folder's own offer (open it, or copy it as a
// plain website) stays last; a search that covered only part says so in a toast, never in the dialog; and "Open
// from folder", a dropped or handed-over folder and File > Open Project's hand-off all ask the same question.
//
// Method: the real WelcomeScreen and ConfirmHost, bundled once, rendered in jsdom over a fake preload bridge whose
// folder answers the test scripts. Every wait polls the DOM (test/helpers/waitFor.js); none is a fixed pause.

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
export { receiveOpenedFolder } from ${JSON.stringify(repoPath('src/features/welcome/FolderDropHost.tsx'))};
export { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};
`;

const FOLDER = '/Users/me/Code/acme';
const found = (relative, name) => ({ projectPath: `${FOLDER}/${relative}`, relative, name });
const nested = (sites, more = {}) => ({ kind: 'nestedSites', folderPath: FOLDER, sites, searched: 'all', instead: { kind: 'nothing' }, ...more });

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'nestedSitesDialog.bundle.js');
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
  global.IS_REACT_ACT_ENVIRONMENT = false;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => PLATFORM_NULL;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext = function WebGLRenderingContext() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { WelcomeScreen, receiveOpenedFolder, ConfirmHost } = require(bundlePath);

  let answer = { kind: 'canceled' };
  let handOver;
  dom.window.avb = {
    onCreateLog: () => () => {},
    // A folder that was waiting when the window came up, as a drop on the app's icon at launch leaves it.
    takeOpenedFolders: async () => [nested([found('waiting/site')])],
    onFolderOpened: (callback) => {
      handOver = callback;
      return () => {};
    },
    openSiteDialog: async () => answer,
    checkAstroCopy: async (request) => ({ ok: true, value: { targetPath: `${request.parentPath}/${request.name}` } }),
    listRecents: async () => [],
  };

  const opened = [];
  const toasts = [];
  const container = dom.window.document.getElementById('root');
  const screen = createRoot(container);
  screen.render(
    React.createElement(
      React.Fragment,
      undefined,
      React.createElement(WelcomeScreen, {
        onOpen: (projectPath) => opened.push(projectPath),
        showToast: (message, kind) => toasts.push({ message, kind }),
      }),
      React.createElement(ConfirmHost),
    ),
  );

  const until = (what, read) => waitFor({ what, read, until: (value) => Boolean(value) });
  const dialog = () => dom.window.document.querySelector('.nested-sites-dialog');
  const text = (selector) => dialog()?.querySelector(selector)?.textContent ?? '';
  const options = () => [...(dialog()?.querySelectorAll('.choice-dialog-option') ?? [])];
  const labels = () => options().map((option) => option.querySelector('.choice-dialog-label').textContent);
  const cancel = () => dialog().querySelector('.modal-footer button').click();
  const closed = () => until('the dialog to close', () => dialog() === null);
  const shown = () => until('the dialog', () => dialog() !== null && options().length > 0);
  const openFromFolder = async () => {
    await until('the welcome screen', () => container.querySelector('.actions button'));
    container.querySelectorAll('.actions button')[0].click();
    await shown();
  };

  // --- a folder handed over at launch -------------------------------------------
  await shown();
  check('a folder waiting at launch asks too', text('.modal-body').includes('waiting/site'), text('.modal-body'));
  cancel();
  await closed();
  check('and Cancel opens nothing', opened.length === 0, opened.join());

  // --- one website ------------------------------------------------------------------
  answer = nested([found('apps/web', '@acme/web')]);
  await openFromFolder();
  check('one website: the title says where it is', text('.modal-header') === 'Your website is in a folder inside', text('.modal-header'));
  check('and the path is named', text('.modal-body').includes('acme holds one website, in apps/web.'), text('.modal-body'));
  check('with one button that opens it', labels().join('|') === 'Open website', labels().join('|'));
  check('the blue primary one, focused', options()[0].classList.contains('primary') && dom.window.document.activeElement === options()[0]);
  check('its package name under it', options()[0].textContent.includes('@acme/web'), options()[0].textContent);
  check('nothing opens before it is pressed', opened.length === 0, opened.join());
  options()[0].click();
  await until('the site to open', () => opened.length === 1);
  check('the button opens the website’s folder', opened[0] === `${FOLDER}/apps/web`, opened[0]);
  await closed();

  // --- several -----------------------------------------------------------------------
  answer = nested([found('apps/docs', 'docs'), found('apps/web', '@acme/web'), found('examples/starter', undefined)]);
  await openFromFolder();
  check('several: the person is asked which', text('.modal-header') === 'Which website do you want to open?', text('.modal-header'));
  check('with how many there are', text('.modal-body').includes('3 websites are inside acme.'), text('.modal-body'));
  check('each named by where it is, in order', labels().join('|') === 'apps/docs|apps/web|examples/starter', labels().join('|'));
  check(
    'none recommended',
    options().every((option) => !option.classList.contains('primary')),
  );
  check('a package name that only repeats the folder is left out', !options()[0].querySelector('.choice-dialog-hint'));
  check('one that says more is shown', options()[1].querySelector('.choice-dialog-hint')?.textContent === '@acme/web');
  dialog()
    .closest('dialog')
    .dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  await closed();
  check('Escape opens nothing', opened.length === 1, opened.join());
  await openFromFolder();
  options()[1].click();
  await until('the chosen site', () => opened.length === 2);
  check('the chosen one opens', opened[1] === `${FOLDER}/apps/web`, opened[1]);
  await closed();

  // --- what the folder could do by itself ---------------------------------------------
  answer = nested([found('apps/web', 'web')], { instead: { kind: 'openFolder' } });
  await openFromFolder();
  check('a folder that opened before can still be opened', labels().join('|') === 'Open website|Open acme itself', labels().join('|'));
  options()[1].click();
  await until('the folder itself', () => opened.length === 3);
  check('and it is the picked folder that opens', opened[2] === FOLDER, opened[2]);
  await closed();

  const offer = { sourcePath: FOLDER, parentPath: '/Users/me/Code', name: 'acme-astro', homePath: '/Users/me' };
  answer = nested([found('apps/web', 'web')], { instead: { kind: 'plainWebsite', offer } });
  await openFromFolder();
  check('a plain website can still be copied', labels()[1] === 'Make an Astro copy of acme instead', labels().join('|'));
  options()[1].click();
  await until('the copy dialog', () => dom.window.document.querySelector('.astro-copy-modal'));
  check('which opens the copy dialog and no project', opened.length === 3, opened.join());
  dom.window.document.querySelector('.astro-copy-modal .modal-footer button').click();
  await until('the copy dialog to close', () => !dom.window.document.querySelector('.astro-copy-modal'));

  // --- a search that covered only part --------------------------------------------------
  const before = toasts.length;
  answer = nested([found('apps/web', 'web')], { searched: 'part' });
  await openFromFolder();
  check(
    'part of the folder unsearched is a toast',
    toasts.length === before + 1 && toasts.at(-1).kind === 'info' && /too big to search all of it/.test(toasts.at(-1).message),
    JSON.stringify(toasts),
  );
  check('and no text in the dialog', !/too big/.test(dialog().textContent), dialog().textContent);
  cancel();
  await closed();

  // --- a dropped folder, and File > Open Project's hand-off ------------------------------
  await until('the window to listen', () => handOver);
  handOver(nested([found('from/icon', 'x')]));
  await shown();
  check('a folder from the app’s icon asks the same question', text('.modal-body').includes('from/icon'), text('.modal-body'));
  options()[0].click();
  await until('it to open', () => opened.length === 4);
  await closed();
  receiveOpenedFolder(nested([found('from/menu', 'x')]));
  await shown();
  check('and so does the answer the menu hands on', text('.modal-body').includes('from/menu'), text('.modal-body'));
  cancel();
  await closed();
  const beforeNone = toasts.length;
  receiveOpenedFolder({ kind: 'notWebsite', folderPath: FOLDER, searched: 'part' });
  check(
    'no website in a folder too large to read says only part was searched',
    toasts.length === beforeNone + 1 && /in the part of that folder it searched/.test(toasts.at(-1).message),
    JSON.stringify(toasts.at(-1)),
  );
  screen.unmount();

  if (failures.length) {
    console.error(`\nnested-sites-dialog: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`nested-sites-dialog: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

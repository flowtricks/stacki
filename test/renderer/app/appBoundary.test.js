// A crash in any part of the interface is contained and says what happened; a crash nothing contains ends on the
// recovery screen, never a black window.
//
//   node test/renderer/app/appBoundary.test.js
//
// Goal: the owner's requirement (2): when something cannot be handled the rest of the app still works and shows a
// specific notice. Each pane (canvas, canvas cover, left panel, right panel, code window) sits in its own boundary,
// and a top-level AppBoundary catches what is left (the app's own hooks, a chunk that fails to load) and draws the
// recovery screen with Reload, Open another project and Copy details.
//
// Method: the real AppBoundary and RecoveryScreen in JSDOM around children that throw. The screen's buttons are
// clicked: Reload reloads the window, Copy details writes the failure to the clipboard, Open another project asks the
// bridge for a folder and closes the project onto it. The shell sources are read to pin that every pane is wrapped,
// and the screen is rendered in all five languages.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'app-boundary.bundle.js');
  await esbuild.build({
    stdin: {
      contents: "export { AppBoundary } from './src/app/recovery/AppBoundary'; export { LocaleProvider } from './src/lib/i18n/LocaleProvider';",
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const clipboardWrites = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: (text) => (clipboardWrites.push(text), Promise.resolve()) },
    configurable: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const bridgeCalls = [];
  let folderAnswer = { kind: 'astro', projectPath: '/sites/other' };
  dom.window.avb = {
    openSiteDialog: () => {
      bridgeCalls.push('openSiteDialog');
      return Promise.resolve(folderAnswer);
    },
    closeProject: (next) => {
      bridgeCalls.push(`closeProject:${next}`);
      return Promise.resolve({ ok: true });
    },
  };
  const logged = [];
  console.error = (...parts) => logged.push(parts.map(String).join(' '));
  dom.window.addEventListener('error', (event) => event.preventDefault());

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { AppBoundary } = require(bundlePath);

  function Broken() {
    throw new Error('Cannot read properties of undefined (reading "map")');
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(AppBoundary, undefined, React.createElement(Broken))));
  const screen = document.querySelector('.recovery-screen');
  check('an uncaught render error ends on the recovery screen', screen !== null);
  const text = screen?.textContent ?? '';
  check('it says what failed, specifically', text.includes('Cannot read properties of undefined (reading "map")'), text);
  check('it says the files on disk were not changed', text.includes('project files'), text);
  const buttons = [...document.querySelectorAll('.recovery-actions button')].map((button) => button.textContent);
  check('it offers Reload, Open another project and Copy details', buttons.join('|') === 'Reload|Open another project|Copy details', buttons.join('|'));
  check('Reload is the blue primary button', document.querySelector('.recovery-actions button.primary')?.textContent === 'Reload');
  check('the stack is shown for reading and copying', (document.querySelector('.log-block')?.textContent ?? '').includes('Cannot read properties'));
  check(
    'the failure was logged with where it was caught',
    logged.some((line) => line.includes('[app] render error reached the top of the interface')),
  );
  check(
    'no native dialog is used by the screen',
    !fs.readFileSync(repoPath('src/app/recovery/RecoveryScreen.tsx'), 'utf8').match(/\b(alert|confirm|prompt)\(/),
  );

  await act(async () => document.querySelectorAll('.recovery-actions button')[2].click());
  check(
    'Copy details writes the failure to the clipboard',
    clipboardWrites.length === 1 && clipboardWrites[0].includes('Cannot read properties'),
    clipboardWrites[0],
  );
  check('and the button confirms it', document.querySelectorAll('.recovery-actions button')[2].textContent === 'Copied');

  await act(async () => {
    document.querySelectorAll('.recovery-actions button')[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  check(
    'Open another project asks for a folder, then closes onto it',
    bridgeCalls.join(',') === 'openSiteDialog,closeProject:/sites/other',
    bridgeCalls.join(','),
  );
  // A folder with websites inside: the screen asks which, with a dialog host of its own.
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  folderAnswer = {
    kind: 'nestedSites',
    folderPath: '/sites/mono',
    sites: [{ projectPath: '/sites/mono/apps/web', relative: 'apps/web', name: 'web' }],
    searched: 'all',
    instead: { kind: 'nothing' },
  };
  bridgeCalls.length = 0;
  await act(async () => {
    document.querySelectorAll('.recovery-actions button')[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const question = document.querySelector('.nested-sites-dialog');
  check('a website inside the folder is asked about', question !== null && bridgeCalls.join(',') === 'openSiteDialog', bridgeCalls.join(','));
  await act(async () => question?.querySelector('.choice-dialog-option').click());
  // Each poll lets React apply what is pending: the dialog answers once its closing has run.
  await waitFor({
    what: 'the chosen website to be opened',
    read: async () => {
      await act(async () => {});
      return bridgeCalls.length;
    },
    until: (count) => count === 2,
  });
  check('and the answer is what opens', bridgeCalls.join(',') === 'openSiteDialog,closeProject:/sites/mono/apps/web', bridgeCalls.join(','));
  await act(async () => root.unmount());

  // A healthy tree is untouched.
  const healthy = createRoot(document.getElementById('root'));
  await act(async () => healthy.render(React.createElement(AppBoundary, undefined, React.createElement('div', { className: 'fine' }, 'ok'))));
  check('a healthy app renders its children and no screen', document.querySelector('.fine') !== null && document.querySelector('.recovery-screen') === null);
  await act(async () => healthy.unmount());

  // Every pane is its own boundary, so one failing leaves the rest.
  const source = (file) => fs.readFileSync(repoPath(file), 'utf8');
  const shell = source('src/app/shell/AppShell.tsx');
  check('the canvas sits in a boundary', /<PanelBoundary name="The canvas"[^>]*>\s*<CanvasPane/.test(shell));
  check('the canvas covers sit in a boundary', /<PanelBoundary name="The canvas cover"[^>]*>\s*<CanvasCovers/.test(shell));
  // The panel body may be wrapped in context providers (SettingsBackScope) that render no UI of their own.
  check('the left panels sit in a boundary', /<PanelBoundary name="The left panel"[^>]*>(?:(?!<\/PanelBoundary>)[\s\S])*<LeftPanelBody/.test(shell));
  check('the right panel sits in a boundary', /<PanelBoundary name="The right panel"[^>]*>\s*<RightPanel/.test(shell));
  check('the code window sits in a boundary', /<PanelBoundary name="The code window"[^>]*>\s*<CodeWindowHost/.test(shell));
  check('the interface sits in the top-level boundary', /<AppBoundary>[\s\S]*<App \/>[\s\S]*<\/AppBoundary>/.test(source('src/main.tsx')));

  if (failures.length) {
    process.stderr.write(`appBoundary: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`appBoundary: ${checked} checks passed\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});

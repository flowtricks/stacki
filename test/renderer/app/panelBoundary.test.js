// A render error stays inside the panel it happened in.
//
//   node test/renderer/app/panelBoundary.test.js
//
// Goal: React unmounts the whole tree on an uncaught render error, so one bad
// value in one panel (the element tooltip's check on a one-letter tag) blanked
// the window and read as a crash. PanelBoundary keeps the failure in place:
// the panel shows what broke and a Try again button, its neighbours keep
// rendering, and a new selection (its reset key) brings the panel back.
//
// Method: the real PanelBoundary in JSDOM around a child that throws while a
// flag is set, beside a sibling that never throws; then the shell files are
// read to pin that the Style, Settings and Navigator panels and the app root
// sit inside one.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

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
  const bundlePath = path.join(buildDirectory, 'panel-boundary.bundle.js');
  await esbuild.build({
    stdin: { contents: "export { default as PanelBoundary } from './src/ui/PanelBoundary'", resolveDir: ROOT, loader: 'tsx' },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // React reports every caught render error to the console; these are expected.
  const logged = [];
  console.error = (...parts) => logged.push(parts.map(String).join(' '));
  dom.window.addEventListener('error', (event) => event.preventDefault());

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { PanelBoundary } = require(bundlePath);
  let broken = true;
  function Fragile() {
    if (broken) {
      throw new Error('Assertion failed: a bad value');
    }
    return React.createElement('div', { className: 'fragile' }, 'fine');
  }
  const app = (selection) =>
    React.createElement(
      'div',
      undefined,
      React.createElement(PanelBoundary, { name: 'The Style panel', resetKey: selection }, React.createElement(Fragile)),
      React.createElement('div', { className: 'neighbour' }, 'navigator'),
    );
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(app('n1')));
  const note = () => document.querySelector('.panel-boundary');
  check('a throwing panel shows an error note in its place', note() !== null);
  check('naming the panel', note()?.textContent.includes('The Style panel hit an error') === true, note()?.textContent);
  check('and what broke', note()?.textContent.includes('a bad value') === true, note()?.textContent);
  check('its neighbour still renders', document.querySelector('.neighbour')?.textContent === 'navigator');
  check(
    'the failure names the panel in the console',
    logged.some((line) => line.includes('[The Style panel] render error contained')),
  );

  await act(async () => root.render(app('n1')));
  check('the same selection keeps the note (no render loop)', note() !== null);
  broken = false;
  await act(async () => root.render(app('n2')));
  check('a new selection tries the panel again', document.querySelector('.fragile')?.textContent === 'fine');
  check('and the note is gone', note() === null);

  broken = true;
  await act(async () => root.render(app('n3')));
  check('a later failure shows the note again', note() !== null);
  broken = false;
  await act(async () => document.querySelector('.panel-boundary-retry').click());
  check('Try again renders the panel once it can', document.querySelector('.fragile')?.textContent === 'fine');
  await act(async () => root.unmount());

  const source = (file) => fs.readFileSync(repoPath(file), 'utf8');
  const panes = source('src/app/shell/AppPanes.tsx');
  check('the Style panel sits in a boundary', /<PanelBoundary name="The Style panel"[^>]*>\s*<StyleTab/.test(panes));
  check('the Settings panel sits in a boundary', /<PanelBoundary name="The Settings panel"[^>]*>\s*<PropsPanel/.test(panes));
  check('the Navigator sits in a boundary', /<PanelBoundary name="The Navigator"[^>]*>\s*<StructurePanel/.test(source('src/app/shell/AppShell.tsx')));
  check('the app root sits in a boundary', /<PanelBoundary name="Stacki"[^>]*>\s*<AppContent/.test(source('src/app/App.tsx')));
  check(
    "Studio's Style panel sits in one",
    /<PanelBoundary name="The Style panel"[^>]*>\s*<StylePanel/.test(source('studio/src/features/settings/StyleSettings.tsx')),
  );

  if (failures.length) {
    process.stderr.write(`panelBoundary: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`panelBoundary: ${checked} checks passed\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});

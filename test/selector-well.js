// The selector well while it is still filling.
//
//   node test/selector-well.js
//
// The well is a black box that holds one chip per selector styling the element.
// Empty, it says "nothing styles this" — and it is empty for the same seconds the
// scan takes, so the panel confidently gave the wrong answer and then quietly
// changed it. These check that the wait shows as a wait: a spinner while the scan
// is running and there is nothing to show yet, and nothing extra once there is
// (or once the scan is done and the answer really is none).
//
// In two halves, because the first version of this only had the first one and the
// spinner still never appeared in the app: the well rendered it correctly, and was
// never told to. So the second half mounts the whole panel over a stylesheet read
// that answers late, and watches the well fill.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'selector-well.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { SelectorPicker } from './EmbedEditor'`,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const { SelectorPicker } = require(bundlePath);

  const CHIPS = [
    { key: 'a', text: 'html.theme-dark' },
    { key: 'b', text: '.theme-dark' },
  ];
  const reactRoot = createRoot(document.getElementById('root'));
  const show = async (props) =>
    act(async () => {
      reactRoot.render(
        React.createElement(SelectorPicker, {
          selectors: [],
          suggestions: [],
          activeSelector: '',
          activePicked: false,
          busy: false,
          loading: false,
          onSelect: () => {},
          onDeselect: () => {},
          onAdd: () => {},
          ...props,
        })
      );
    });
  const spinner = () => document.querySelector('.embed-editor_selector-loading');
  const chips = () => document.querySelectorAll('.embed-editor_selector-chip').length;

  await show({ loading: true });
  check('an empty well says it is still counting', spinner() != null);
  check('and says so in words, for a screen reader', /finding/i.test(spinner()?.textContent || ''), spinner()?.textContent);
  check('with no chips beside it', chips() === 0, `${chips()} chips`);

  await show({ loading: true, selectors: CHIPS });
  check('chips that have arrived show without a spinner', spinner() == null && chips() === 2, `${chips()} chips`);

  await show({ loading: false, selectors: [] });
  check('a finished scan with no selectors shows an empty well', spinner() == null && chips() === 0);

  await show({ loading: false, selectors: CHIPS });
  check('and a finished one with selectors shows them', spinner() == null && chips() === 2, `${chips()} chips`);

  // A global selector (`:target`, `*`) is folded away unless asked for — the well
  // then has nothing in it, and the scan is over, so it must not spin forever.
  await show({ loading: false, selectors: [{ key: 'g', text: ':focus-visible' }] });
  check('a folded-away global leaves the well quiet', spinner() == null && chips() === 0, `${chips()} chips`);

  // --- the whole panel, from a cold open ------------------------------------
  //
  // What the panel does on a real open, in order: it mounts and scans before the
  // project's stylesheet list has been fetched, reads nothing, matches nothing,
  // and calls itself ready. The list lands a moment later. Until this, the well
  // stayed empty and silent through all of it — the panel only noticed the files
  // on its next background refresh, throttled to 4s, which is exactly how long a
  // layout's well sat blank while the CSS that styles it was there on disk.
  const panelBundle = path.join(buildDir, 'panel-mount.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as EmbedEditor } from './EmbedEditor'
        export { setHost } from './lib/host'
        export { setCanvasFrame } from '../canvasQuery.js'
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: panelBundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const READ_MS = 250;
  const SHEET = { rel: 'src/styles/main.css', name: 'main.css', path: '/p/src/styles/main.css', size: 10 };
  dom.window.avb = {
    listStyleFiles: async () => ({ files: [] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: () =>
      new Promise((r) => dom.window.setTimeout(() => r({ css: 'section { margin: 0 } .card { color: red }' }), READ_MS)),
  };

  const { EmbedEditor, setHost, setCanvasFrame } = require(panelBundle);
  // A classless element, so the well holds only what the stylesheets earn — an
  // element's own class gets a chip either way, which would hide the empty case.
  const NODES = [
    { id: 'n1', kind: 'element', name: 'section', props: {} },
    { id: 'n2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'card' } } },
  ];
  setHost({
    projectPath: '/p',
    nodes: NODES,
    selectedId: 'n1',
    files: [], // not listed yet — the fetch is still in flight
    astroFiles: [],
    renderedClasses: [],
    pathOf: () => '0.1',
  });

  const panel = document.createElement('div');
  document.body.appendChild(panel);
  // No act(): the panel is deliberately watched mid-flight, which is the one
  // state act() exists to skip past.
  global.IS_REACT_ACT_ENVIRONMENT = false;
  const panelRoot = createRoot(panel);
  panelRoot.render(React.createElement(EmbedEditor));
  const wait = (ms) => new Promise((r) => dom.window.setTimeout(r, ms));
  const panelChips = () => [...panel.querySelectorAll('.embed-editor_selector-chip')];
  const panelSpinner = () => panel.querySelector('.embed-editor_selector-loading');

  await wait(200);
  check('the panel mounts', panel.querySelector('.embed-editor_selector-well') != null);
  check('a project with no stylesheets to read settles empty', panelChips().length === 0, `${panelChips().length} chips`);
  check('and does not pretend to be waiting', panelSpinner() == null);

  // The list arrives, after the panel already called itself ready.
  setHost({ files: [SHEET] });
  await wait(60);
  check('the well waits on stylesheets it has just been offered', panelSpinner() != null);
  check('with nothing in it yet', panelChips().length === 0, `${panelChips().length} chips`);

  await wait(READ_MS + 400); // still far inside the 4s refresh throttle it used to wait out
  check('the rule in the late stylesheet reaches the well', panelChips().length === 1, panelChips().map((c) => c.textContent).join(','));
  check('as the selector that stylesheet holds', panelChips()[0]?.textContent === 'section', panelChips()[0]?.textContent);
  check('and the spinner goes with it', panelSpinner() == null);

  // --- and on the next element, with the stylesheets already read -----------
  //
  // The other wait: picking another element re-uses the scanned stylesheets, so
  // nothing is re-read and the panel never re-enters its scanning phase. What it
  // waits on is the canvas answering what the element really renders as. A frame
  // that never answers stands in for a busy one (the ask gives up after ~1.5s).
  setCanvasFrame({ postMessage() {} });
  setHost({ selectedId: 'n2' }); // same nodes — only the selection moves, as in the app
  await wait(120);
  check('picking another element empties the well', panelChips().length === 0, `${panelChips().length} chips`);
  check('and it spins while the canvas is asked', panelSpinner() != null);

  await wait(2000);
  check('the well fills once the answer (or its absence) lands', panelChips().length === 1, panelChips().map((c) => c.textContent).join(','));
  check('and stops spinning', panelSpinner() == null);

  if (failures.length) {
    console.error(`selector-well: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selector-well: ${checked} passed  [well markup, cold open, late stylesheets, next element]`);
  // jsdom's timers keep the loop alive.
  process.exit(0);
})();

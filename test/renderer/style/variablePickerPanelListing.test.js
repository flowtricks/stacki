// The variable chooser in a custom property's value lists the Variables panel's variables, as the
// panel shows them, less the hidden ones and the one being declared.
//
//   node test/renderer/style/variablePickerPanelListing.test.js
//
// Goal: where `--x: |` is written, the chooser offers every variable of the project, of every kind (a
// custom property takes any value), in the panel's files, rule groups, headed blocks and row order,
// with no variable the panel's "hide from suggestions" setting hides (not even the one applied), and
// never the custom property being declared itself.
// Method: the pure listing (panelVariableList.ts) is built from a panel snapshot in the shape the
// panel's reader returns, and checked for order, blocks, self exclusion and the declared-name read.
// Then the real VariablePicker is rendered in jsdom over that listing, with the hidden-names store
// backed by an in-memory file, and its drawn headings and rows are read in document order.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const cell = (name, value, color) => ({
  name,
  value,
  file: 'src/styles/global.css',
  selector: ':root',
  valueStart: 0,
  valueEnd: 0,
  line: 1,
  column: '',
  ...(color === undefined ? {} : { color }),
});
const row = (label, ...cells) => ({ label, cells });
// The panel's snapshot: a stylesheet with headed blocks (light, brand, font sizes), and a page's
// `<style>` block after it, in the order the panel draws them.
const SNAPSHOT = {
  values: {},
  files: [
    {
      rel: 'src/styles/global.css',
      name: 'global.css',
      groups: [
        {
          kind: 'single',
          label: ':root',
          columns: [],
          blocks: [
            { kind: 'rows', title: 'light', rows: [row('100', cell('--light-100', 'white', 'white')), row('200', cell('--light-200', '#eee', '#eee'))] },
            {
              kind: 'rows',
              title: 'brand',
              rows: [row('1', cell('--brand-1', '#c6fb50', '#c6fb50')), row('1 text', cell('--brand-1-text', 'var(--light-100)', 'white'))],
            },
            { kind: 'rows', title: 'Font sizes', rows: [row('h1', cell('--h1', '4rem')), row('h3', cell('--h3', '2rem'))] },
          ],
        },
      ],
    },
    {
      rel: 'src/pages/index.astro',
      name: '<style>',
      groups: [
        {
          kind: 'single',
          label: ':root',
          columns: [],
          blocks: [
            {
              kind: 'rows',
              title: undefined,
              rows: [row('border color', cell('--border-color', 'var(--dark-900)')), row('dark', cell('--dark-900', '#111', '#111'))],
            },
          ],
        },
      ],
    },
  ],
};
const PANEL_ORDER = ['--light-100', '--light-200', '--brand-1', '--brand-1-text', '--h1', '--h3', '--border-color', '--dark-900'];

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'panel-listing.bundle.js');
  await esbuild.build({
    stdin: {
      contents: [
        "export { VariablePicker } from './src/features/style/VariablePicker';",
        "export { panelListing, panelBlockKey, declaredPropertyAt, PANEL_LISTING_MAX } from './src/features/style/model/panelVariableList';",
        "export { setHost, getHost } from './src/features/style/model/host';",
        "export { hiddenVariablesStore, forgetHiddenVariables } from './src/ipc/hiddenVariables';",
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            export async function streamProjectVariables() { return []; }
            export async function getProjectFontFamilies() { return []; }
            export async function getImageAssets() { return []; }
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  dom.window.requestAnimationFrame = global.requestAnimationFrame;
  dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.Element.prototype.scrollIntoView = () => {};

  const bundle = require(bundlePath);

  // --- The pure listing: the panel's order and blocks, every kind, never the declared name.
  {
    const known = [{ name: 'h1', collection: 'x', group: '', value: '4rem', binding: 'var(--h1)', type: 'Size' }];
    const all = bundle.panelListing(SNAPSHOT, { self: undefined, known });
    check(
      'every variable is listed, in the panel’s order',
      JSON.stringify(all.variables.map((variable) => `--${variable.name}`)) === JSON.stringify(PANEL_ORDER),
      all.variables.map((variable) => variable.name).join(' '),
    );
    check('colours and sizes alike', all.variables.some((variable) => variable.type === 'Color') && all.variables.some((variable) => variable.type === 'Size'));
    const blocks = all.blocks.get(bundle.panelBlockKey('global.css', ':root'));
    check(
      'the panel’s headed blocks, in order',
      JSON.stringify(blocks.map((block) => block.title)) === JSON.stringify(['light', 'brand', 'Font sizes']),
      JSON.stringify(blocks),
    );
    const own = bundle.panelListing(SNAPSHOT, { self: '--border-color', known });
    check('the variable being declared is never offered to itself', !own.variables.some((variable) => variable.name === 'border-color'));
    check('and is left out of its block too', !own.blocks.get(bundle.panelBlockKey('<style>', ':root'))[0].names.includes('--border-color'));
    const failed = bundle.panelListing({ values: {}, files: [{ rel: 'a.css', name: 'a.css', groups: [], error: 'bad' }] }, { self: undefined, known });
    check('a file the panel could not read lists nothing', failed.variables.length === 0);
    const text = ':root {\n  --border-color: var(--da\n}';
    check('the declared name is read before the value', bundle.declaredPropertyAt(text, text.indexOf('var(')) === '--border-color');
    check('an ordinary property is no custom one', bundle.declaredPropertyAt('.a { color: var(', '.a { color: var('.length) === undefined);
  }

  // --- The picker draws that listing as the panel does, less what the panel hides.
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const PROJECT = '/fixture/project';
  let source;
  bundle.forgetHiddenVariables();
  const store = bundle.hiddenVariablesStore(PROJECT, { read: async () => ({ source }), write: async (write) => ((source = write.source), { source }) });
  bundle.setHost({ ...bundle.getHost(), projectPath: PROJECT });
  await act(async () => void (await store.hide('--light-200')));
  await act(async () => void (await store.hide('--dark-900')));
  const listing = bundle.panelListing(SNAPSHOT, { self: '--border-color', known: [] });
  const anchorRow = document.createElement('div');
  const anchor = document.createElement('span');
  anchorRow.append(anchor);
  document.body.append(anchorRow);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(bundle.VariablePicker, {
        anchor,
        vars: [...listing.variables],
        loading: false,
        panel: { blocks: listing.blocks },
        selectedBinding: 'var(--dark-900)',
        onPick() {},
        onClose() {},
      }),
    );
  });
  // The hidden names arrive from their store after the first render: wait until the list has them.
  const drawnRows = () => [...document.querySelectorAll('.embed-editor_varpicker-item')].map((item) => item.dataset.binding);
  const rows = await waitFor({
    what: 'the picker draws the listing less the hidden names',
    read: async () => {
      await act(async () => undefined);
      return drawnRows();
    },
    until: (drawn) => drawn.length > 0 && !drawn.includes('var(--light-200)'),
  });
  check(
    'the rows are the panel’s, in its order, less the hidden ones and the declared one',
    JSON.stringify(rows) === JSON.stringify(['var(--light-100)', 'var(--brand-1)', 'var(--brand-1-text)', 'var(--h1)', 'var(--h3)']),
    rows.join(' '),
  );
  check('a hidden variable stays out even where it is applied', !rows.includes('var(--dark-900)'));
  const headings = [...document.querySelectorAll('.embed-editor_varpicker-family-name')].map((heading) => heading.textContent);
  check('the panel’s headings', JSON.stringify(headings) === JSON.stringify(['light', 'brand', 'Font sizes']), headings.join(' | '));
  const collections = [...document.querySelectorAll('.embed-editor_varpicker-collection-name')].map((name) => name.textContent);
  check(
    'the panel’s files, in order, a file with nothing left dropped',
    JSON.stringify(collections) === JSON.stringify(['global.css']),
    collections.join(' | '),
  );
  await act(async () => root.unmount());

  if (failures.length) {
    console.error(`variable picker panel listing: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variable picker panel listing: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

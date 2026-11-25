// Goal: the Variables panel lists a page's or a component's `<style>` variables only
// while that file is open, stylesheets and layouts always, and the style pickers
// never offer another page's `<style>` variables, while keeping the open page's
// own value for a name a stylesheet also declares.
// Method: a real project on disk is read by the real main-process reader. The rule
// itself is checked as a pure function, including the negative space (another page,
// a component not open, a path outside the project). The real panel is then
// rendered in jsdom on page A, on page B and inside a component, and the real
// picker list is read with the style host set to each place, so the only stand-in
// is the IPC bridge.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const cssVars = require('#dist/electron/project/cssVars.js');
const rendererModule = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

fs.mkdirSync(repoPath('node_modules/.stacki-test'), { recursive: true });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function bundle(contents, name, external) {
  // Inside the repository, so a bundle that leaves React out still resolves the repository's own.
  const output = path.join(fs.mkdtempSync(path.join(repoPath('node_modules/.stacki-test'), 'variable-place-')), `${name}.cjs`);
  buildSync({
    stdin: { contents, resolveDir: repoPath('.'), loader: 'ts' },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external,
    logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  return output;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variable-place-project-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), text);
};

function checkRule() {
  const { variableFileListed, variableFileOffered, variableFileReach, projectRelative } = rendererModule('src/editor/variablePlace.ts');
  const onFirstPage = { openFile: 'src/pages/a.astro', contextPage: undefined };
  assert.equal(variableFileReach('src/styles/base.css'), 'global');
  assert.equal(variableFileReach('src/layouts/Base.astro'), 'global');
  assert.equal(variableFileReach('src/pages/a.astro'), 'page');
  assert.equal(variableFileReach('src/components/site/Card.astro'), 'component');
  assert.equal(variableFileListed('src/styles/base.css', onFirstPage), true, 'a stylesheet is always listed');
  assert.equal(variableFileListed('src/layouts/Base.astro', onFirstPage), true, 'a layout is always listed');
  assert.equal(variableFileListed('src/pages/a.astro', onFirstPage), true, 'the open page is listed');
  assert.equal(variableFileListed('src/pages/b.astro', onFirstPage), false, 'another page is not');
  assert.equal(variableFileListed('src/components/Card.astro', onFirstPage), false, 'a component is not, from a page');
  const inCard = { openFile: 'src/components/Card.astro', contextPage: 'src/pages/a.astro' };
  assert.equal(variableFileListed('src/components/Card.astro', inCard), true, 'the open component is listed');
  assert.equal(variableFileListed('src/pages/a.astro', inCard), false, 'the page it is shown on is not listed');
  assert.equal(variableFileOffered('src/pages/b.astro', onFirstPage), false, 'a picker never offers another page');
  assert.equal(variableFileOffered('src/pages/a.astro', onFirstPage), true);
  assert.equal(variableFileOffered('src/components/Card.astro', onFirstPage), true, 'a component is left to the canvas');
  assert.equal(variableFileOffered('src/pages/a.astro', inCard), true, 'the page a component is shown on reaches it');
  assert.equal(variableFileOffered('src/pages/b.astro', inCard), false);
  assert.equal(projectRelative('/work/site', '/work/site/src/pages/a.astro'), 'src/pages/a.astro');
  assert.equal(projectRelative('/work/site/', '/work/site/src/pages/a.astro'), 'src/pages/a.astro');
  assert.equal(projectRelative('studio', 'src/pages/a.astro'), 'src/pages/a.astro', 'Studio paths are relative already');
  assert.equal(projectRelative('/work/site', '/work/site-two/src/pages/a.astro'), '/work/site-two/src/pages/a.astro', 'a sibling folder is not inside');
  assert.equal(projectRelative('/work/site', undefined), undefined);
  assert.throws(() => variableFileReach(''), /a file has a path/);
}

async function checkPanel() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.avb = { cssVariables: async () => cssVars.readVariables(directory), onCssChanged: () => () => {} };
  const output = bundle("export { default } from './src/features/variables/VariablesPanel';", 'panel', ['react', 'react-dom', 'react/jsx-runtime']);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Panel = require(output).default;
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const names = () => [...container.querySelectorAll('.cms-collection-name')].map((node) => node.textContent).sort();
  const show = (openFile, contextPage) =>
    act(async () => {
      root.render(React.createElement(Panel, { project: { path: directory }, place: { openFile, contextPage }, selected: undefined, onSelect() {} }));
      await settle(40);
    });
  await show('src/pages/a.astro', undefined);
  assert.deepEqual(names(), ['base.css', 'layouts/Base.astro', 'pages/a.astro'], 'on page A: globals and A, not B, not the component');
  await show('src/pages/b.astro', undefined);
  assert.deepEqual(names(), ['base.css', 'layouts/Base.astro', 'pages/b.astro'], 'on page B: B replaces A');
  await show('src/components/Card.astro', 'src/pages/a.astro');
  assert.deepEqual(names(), ['base.css', 'components/Card.astro', 'layouts/Base.astro'], 'inside the component: its own, and not the page it is shown on');
  await show(undefined, undefined);
  assert.deepEqual(names(), ['base.css', 'layouts/Base.astro'], 'with nothing open, only what reaches every page');
  await act(async () => root.unmount());
}

async function checkPicker() {
  const output = bundle(
    [
      "export { getHost, setHost } from './src/features/style/model/host';",
      "export { streamProjectVariables } from './src/features/style/model/projectResources';",
      "export { variablesAt, hostVariablePlace } from './src/features/style/sharedVars';",
    ].join('\n'),
    'picker',
    [],
  );
  globalThis.window = {
    avb: {
      cssVariables: async (project) => cssVars.readVariables(project),
      listStyleFiles: async () => ({ files: [{ rel: 'src/styles/base.css', name: 'base.css', path: path.join(directory, 'src/styles/base.css'), size: 1 }] }),
      listAstroStyleFiles: async () => ({ files: [] }),
      readStyleFile: async (file) => ({ css: fs.readFileSync(file, 'utf8') }),
      onCssChanged: () => () => {},
    },
  };
  const picker = require(output);
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
  const { getHost, setHost, streamProjectVariables, variablesAt, hostVariablePlace } = picker;
  setHost({ ...getHost(), projectPath: directory, openFilePath: path.join(directory, 'src/pages/a.astro'), openFileKind: 'page' });
  const all = await streamProjectVariables(() => {});
  const offeredOn = (place) => variablesAt(all, place);
  const onFirstPage = offeredOn(hostVariablePlace());
  assert.deepEqual(hostVariablePlace(), { openFile: 'src/pages/a.astro', contextPage: undefined }, 'the host place is project-relative');
  const named = (list, name) => list.filter((variable) => variable.name === name);
  assert.equal(named(onFirstPage, 'b-only').length, 0, 'page B’s variable is not offered on page A');
  assert.equal(named(onFirstPage, 'a-only').length, 1, 'page A’s own is');
  assert.equal(named(onFirstPage, 'accent')[0]?.value, 'red', 'a name both pages declare is offered once, at the open page’s value');
  assert.equal(named(onFirstPage, 'accent').length, 1);
  assert.equal(named(onFirstPage, 'brand').length, 1, 'stylesheet variables are always offered');
  assert.equal(named(onFirstPage, 'shell').length, 1, 'layout variables are always offered');
  assert.equal(named(onFirstPage, 'card-pad').length, 1, 'a component’s stay, for the canvas to narrow to the selection');
  const onSecondPage = offeredOn({ openFile: 'src/pages/b.astro', contextPage: undefined });
  assert.equal(named(onSecondPage, 'a-only').length, 0, 'page A’s variable is not offered on page B');
  assert.equal(named(onSecondPage, 'accent')[0]?.value, 'green', 'page B offers its own value');
  const inCard = offeredOn({ openFile: 'src/components/Card.astro', contextPage: 'src/pages/b.astro' });
  assert.equal(named(inCard, 'b-only').length, 1, 'the page a component is shown on reaches it');
  assert.equal(named(inCard, 'a-only').length, 0, 'another page still does not');
  assert.throws(() => variablesAt(all, { openFile: '', contextPage: undefined }), /an open file has a path/);
}

(async () => {
  try {
    write('src/styles/base.css', ':root { --brand: blue; --accent: black; }\n');
    write('src/layouts/Base.astro', '<style is:global>:root { --shell: 1200px; }</style>\n<slot />\n');
    write('src/pages/a.astro', '<style>:root { --a-only: 1rem; --accent: red; }</style>\n<h1>A</h1>\n');
    write('src/pages/b.astro', '<style>:root { --b-only: 2rem; --accent: green; }</style>\n<h1>B</h1>\n');
    write('src/components/Card.astro', '<style>.card { --card-pad: 8px; }</style>\n<div class="card"><slot /></div>\n');
    checkRule();
    await checkPanel();
    await checkPicker();
    console.log('variable place: ok');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

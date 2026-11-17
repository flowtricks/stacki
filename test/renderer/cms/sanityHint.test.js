// Goal: Settings > CMS connections says "This site uses Sanity" when the site's package.json lists
// @sanity/astro or sanity and no Sanity connection exists yet, and says nothing otherwise: once a
// Sanity connection is saved, for a site without Sanity, or when package.json cannot be read.
// Method: bundle the real CmsConnections with esbuild, mount it in jsdom over a fake preload bridge
// whose package.json text and connection list each test sets, and read the panel's sentences.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const output = repoPath('node_modules/.stacki-test/sanity-hint.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: { contents: `export { CmsConnections } from './src/features/cmsConnections/CmsConnections';`, resolveDir: repoPath('.'), loader: 'ts' },
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

const SANITY_CONNECTION = { id: 'c1', kind: 'sanity', label: 'Kade', projectId: 'abc123', dataset: 'production' };
let manifest = async () => ({ text: '{}' });
let connections = [];
const reads = [];
window.avb = {
  readSourceText: async (input) => {
    reads.push(input.rel);
    return manifest();
  },
  cmsConnections: async () => ({ encryption: 'available', connections }),
  emDashProject: async () => ({ kind: 'absent' }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
let root;
test.before(async () => {
  await bundled;
  component = require(output);
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});

const HINT = 'This site uses Sanity. Connect it to edit its content in Stacki.';
async function panelText() {
  reads.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(component.CmsConnections, { projectPath: '/site' })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(reads, ['package.json'], 'the panel reads package.json once');
  return [...document.querySelectorAll('.cms-connections p')].map((paragraph) => paragraph.textContent);
}

test('a site that depends on @sanity/astro or sanity, with no Sanity connection, is told it uses Sanity', async () => {
  connections = [];
  manifest = async () => ({ text: '{"dependencies":{"@sanity/astro":"^3"}}' });
  assert.ok((await panelText()).includes(HINT));
  manifest = async () => ({ text: '{"devDependencies":{"sanity":"^6"}}' });
  assert.ok((await panelText()).includes(HINT));
});

test('no hint once a Sanity connection exists, for a site without Sanity, or when package.json cannot be read', async () => {
  manifest = async () => ({ text: '{"dependencies":{"@sanity/astro":"^3"}}' });
  connections = [SANITY_CONNECTION];
  assert.equal((await panelText()).includes(HINT), false);
  connections = [];
  manifest = async () => ({ text: '{"dependencies":{"astro":"^5"}}' });
  assert.equal((await panelText()).includes(HINT), false);
  manifest = async () => {
    throw new Error('no package.json');
  };
  assert.equal((await panelText()).includes(HINT), false);
});

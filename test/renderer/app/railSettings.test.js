// Goal: the Settings button sits at the rail's foot immediately before the AI chat button, carries the
// tooltip text "Settings", opens the project Settings panel, is hidden from a role without the panel
// (the built-in client by default), and stays when there is no AI button.
// Method: bundle the real LeftRail with the real role store, mount it in jsdom and read the buttons in
// document order; hover for the tooltip; switch the role and mount again.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/rail-settings.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as LeftRail } from './src/app/LeftRail';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { ADMIN_VIEW, roleViewOf, DEFAULT_PROJECT_ROLES } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
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
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
window.avb = { listApps: async () => ({ ok: true, value: [] }) };

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const rail = require(output);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const selected = [];
let root;
async function mount(withAi) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const aiButton = withAi ? { active: false, onSelect: () => selected.push('ai') } : undefined;
  await act(async () =>
    root.render(React.createElement(rail.LeftRail, { projectPath: '/project', onSelect: (tab) => selected.push(tab), componentOpen: false, aiButton })),
  );
  await settle();
}
const labels = () => [...document.querySelectorAll('.rail-btn')].map((button) => button.getAttribute('aria-label'));

test('Settings is the button immediately before AI chat, at the foot of the rail', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  await mount(true);
  const all = labels();
  assert.equal(all.at(-1), 'AI chat');
  assert.match(all.at(-2), /^Settings \(/, 'Settings immediately before AI chat');
  const anchor = document.querySelector('.rail-anchor');
  assert.deepEqual(
    [...anchor.querySelectorAll('.rail-btn')].map((button) => button.getAttribute('aria-label')?.split(' (')[0]),
    ['Settings', 'AI chat'],
  );
  await act(async () => root.unmount());
});

test('hovering shows the Settings tooltip, and a click selects the project Settings panel', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  selected.length = 0;
  await mount(true);
  const button = [...document.querySelectorAll('.rail-btn')].find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Settings'));
  await act(async () => button.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  await act(async () => button.click());
  assert.deepEqual(selected, ['projectSettings']);
  await act(async () => root.unmount());
});

test('without an AI button Settings still anchors the foot; the client role does not get it', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  await mount(false);
  assert.match(labels().at(-1), /^Settings/);
  await act(async () => root.unmount());
  rail.setActualRole(rail.roleViewOf(rail.DEFAULT_PROJECT_ROLES, 'client'));
  await mount(true);
  assert.ok(!labels().some((label) => label?.startsWith('Settings')));
  assert.equal(labels().at(-1), 'AI chat');
  await act(async () => root.unmount());
});

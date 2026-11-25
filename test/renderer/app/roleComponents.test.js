// Goal: Settings → Roles lets an admin choose, per role (admin's own card included), which components the role may
// add: the Components section shows the project's folders and components with their counts ("2 of 4 visible"), a
// three-state switch per folder and a switch per component, a note when a folder decides a row ("hidden by folder
// src/components/interactive"), a search that filters the tree, "Copy from role", and rules for paths that no longer
// exist apart with a way to remove them. Every change saves at once to `.stacki/roles.json`.
// Method: bundle the real RolesSettings and edit model through esbuild, mount it in jsdom over a fake metadata bridge
// that records writes, give it a generated list of component files (never a real project), drive it with clicks and
// typing, and read each write back with the shared parser. A large generated tree checks the window draws few rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/role-components.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { RolesSettings } from './src/app/settings/RolesSettings';",
      "export * from './src/lib/currentRole';",
      "export { buildComponentTree, flattenRows } from './src/app/settings/componentTree';",
      "export { parseProjectRolesSource, ADMIN_VIEW } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
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
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.scrollIntoView = () => undefined;

let stored;
window.avb = {
  projectMetadata: async () => ({ ok: true, value: stored === undefined ? {} : { source: stored } }),
  writeProjectMetadata: async (input) => {
    stored = input.write.source;
    return { ok: true, value: { source: stored } };
  },
  rolesIdentity: async () => ({ login: 'owner' }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const roles = require(output);

const FILES = [
  'src/components/Card.astro',
  'src/components/interactive/Modal.astro',
  'src/components/interactive/Tabs.astro',
  'src/components/ui/Button.astro',
];
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
let root;
async function mount(files = FILES) {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(roles.RolesSettings, { projectPath: '/project', componentFiles: files })));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
}
async function click(element) {
  assert.ok(element, 'the control exists');
  await act(async () => element.click());
  await settle();
}
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
// A role's card, or its open detail view (RoleDetail.tsx).
const card = (name) =>
  document.querySelector(`section.app-role-detail[aria-label$="· ${name}"]`) ?? document.querySelector(`section[aria-label="${name} role"]`);
// Opens a role's Components view from its card, going back first when another view is open.
async function openComponents(name) {
  const back = document.querySelector('.app-role-back');
  if (back) {
    await click(back);
  }
  await click(document.querySelector(`button[aria-label="Open Components for ${name}"]`));
}
const summary = (name) => document.querySelector(`button[aria-label="Open Components for ${name}"] .app-role-row-summary`)?.textContent;
const saved = () => roles.parseProjectRolesSource(stored);
const rulesOf = (id) => saved().roles.find((role) => role.id === id).componentRules;
const section = (name) => card(name).querySelector('.app-role-components-body');
const check = (name, label) => section(name).querySelector(`[role="checkbox"][aria-label="${label}"]`);
const count = (name) => card(name).querySelector('.app-role-detail-count').textContent;
const rows = (name) => [...section(name).querySelectorAll('[role="treeitem"]')].map((row) => row.querySelector('.app-role-components-name').textContent);
const fresh = () => {
  stored = JSON.stringify({ version: 1, roles: [{ id: 'admin', members: ['owner'] }, { id: 'client' }] });
  roles.setActualRole(roles.ADMIN_VIEW);
};

test('every role, admin included, has a Components section that counts what is visible and starts with everything on', async () => {
  fresh();
  await mount();
  assert.equal(summary('Admin'), '4 of 4', 'admin can be restricted too');
  assert.equal(summary('Client'), '4 of 4', 'the card row counts what is visible');
  await openComponents('Client');
  assert.equal(count('Client'), '4 of 4 visible');
  assert.deepEqual(rows('Client'), ['src', 'components', 'Card.astro', 'interactive', 'ui'], 'the top folders are open');
  assert.equal(check('Client', 'Hide interactive').getAttribute('aria-checked'), 'true');
  await unmount();
});

test('a folder switch hides everything in it, reads mixed when some are hidden, and saves at once', async () => {
  fresh();
  await mount();
  await openComponents('Client');
  await click(check('Client', 'Hide interactive'));
  assert.deepEqual(rulesOf('client'), [{ kind: 'folder', path: 'src/components/interactive', effect: 'hide' }]);
  assert.equal(count('Client'), '2 of 4 visible');
  assert.equal(check('Client', 'Show interactive').getAttribute('aria-checked'), 'false');
  assert.equal(check('Client', 'Show components').getAttribute('aria-checked'), 'mixed', 'the parent folder is mixed');
  assert.deepEqual(rulesOf('admin'), [], 'another role is untouched');
  await unmount();
});

test('a row says which folder decides it, and its own switch re-shows one component inside a hidden folder', async () => {
  fresh();
  await mount();
  await openComponents('Client');
  await click(check('Client', 'Hide interactive'));
  await type(card('Client').querySelector('input[aria-label="Search components"]'), 'tabs');
  assert.deepEqual(rows('Client'), ['src', 'components', 'interactive', 'Tabs.astro'], 'the search keeps matches and the folders above them');
  assert.match(section('Client').textContent, /hidden by folder/);
  await click(check('Client', 'Show Tabs.astro'));
  assert.deepEqual(rulesOf('client'), [
    { kind: 'folder', path: 'src/components/interactive', effect: 'hide' },
    { kind: 'component', path: 'src/components/interactive/Tabs.astro', effect: 'show' },
  ]);
  assert.equal(count('Client'), '3 of 4 visible');
  assert.match(section('Client').textContent, /shown despite its folder/);
  await type(card('Client').querySelector('input[aria-label="Search components"]'), 'zzz');
  assert.match(section('Client').textContent, /No components match/);
  await unmount();
});

test("an admin's own components can be hidden, and Copy from role takes another role's choices", async () => {
  fresh();
  await mount();
  await openComponents('Admin');
  await click(check('Admin', 'Hide ui'));
  assert.deepEqual(rulesOf('admin'), [{ kind: 'folder', path: 'src/components/ui', effect: 'hide' }]);
  assert.ok(card('Admin'), 'the settings screen is still there for the restricted admin');
  await openComponents('Client');
  await click(section('Client').querySelector('button[aria-label="Copy from role"]'));
  const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === 'Admin');
  await click(option);
  assert.deepEqual(rulesOf('client'), rulesOf('admin'));
  await unmount();
});

test('a rule for a path that no longer exists is listed apart and can be removed', async () => {
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', componentRules: [{ kind: 'folder', path: 'src/components/gone' }] },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await openComponents('Client');
  assert.match(section('Client').textContent, /Rules for paths that no longer exist/);
  assert.equal(count('Client'), '4 of 4 visible', 'a missing rule hides nothing');
  await click(section('Client').querySelector('button[aria-label="Remove the rule for src/components/gone"]'));
  assert.deepEqual(rulesOf('client'), []);
  assert.equal(section('Client').querySelector('.app-role-components-missing') === null, true);
  await unmount();
});

test('a project with thousands of components draws a window of rows, and the tree is built in one pass', async () => {
  const files = Array.from({ length: 5000 }, (_, index) => `src/components/group${index % 50}/Item${index}.astro`);
  const tree = roles.buildComponentTree(files, [{ kind: 'folder', path: 'src/components/group1', effect: 'hide' }]);
  assert.equal(tree.total, 5000);
  assert.equal(tree.visible, 4900);
  const all = roles.flattenRows(tree, new Set(tree.folderPaths), '');
  assert.equal(all.length, 5000 + tree.folderPaths.length);
  fresh();
  await mount(files);
  await openComponents('Client');
  await click(section('Client').querySelector('button[aria-label="Open or close group0"]'));
  assert.ok(section('Client').querySelectorAll('[role="treeitem"]').length <= 30, 'only a window of the rows is in the page');
  await unmount();
});

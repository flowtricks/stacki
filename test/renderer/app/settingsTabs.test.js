// Goal: the Settings dialog is a set of tabs (Editor settings, Folders, CMS connections,
// Stacki Studio, Instructions, Audits, Roles) that show the right panel, move with the arrow keys, remember
// the last tab, open on CMS connections when the CMS rail asks for it, and leave out
// the tabs the project's role hides.
// Method: bundle the real Settings component with esbuild, stub the Folders, CMS and
// Studio sections (their own suites cover them) so each panel is recognisable,
// mount it in jsdom with a fake bridge and localStorage, and drive it through
// the File menu, openAppSettings and keyboard events. The storage parser is
// checked directly, including values an earlier build or a corrupt store could hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/settings-tabs.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const stubs = {
  name: 'settings-section-stubs',
  setup(build) {
    build.onResolve(
      { filter: /cmsConnections\/CmsConnections$|studioSetup\/StudioSetup$|\/FolderSettings$|\/RolesSettings$|\/InstructionsSettings$|\/AuditsSettings$/ },
      (args) => ({
        path: args.path,
        namespace: 'stub',
      }),
    );
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      loader: 'jsx',
      contents: args.path.includes('AuditsSettings')
        ? 'export function AuditsSettings() { return <section aria-label="Audit checks">Audits stub</section>; }'
        : args.path.includes('InstructionsSettings')
          ? 'export function InstructionsSettings() { return <section aria-label="Hidden instructions">Instructions stub</section>; }'
          : args.path.includes('RolesSettings')
            ? 'export function RolesSettings() { return <section aria-label="Project roles">Roles stub</section>; }'
            : args.path.includes('FolderSettings')
              ? 'export function FolderSettings() { return <section aria-label="Project folders">Folders stub</section>; }'
              : args.path.includes('CmsConnections')
                ? 'export function CmsConnections() { return <section aria-label="CMS connections">CMS stub</section>; }'
                : 'export default function StudioSetup() { return <section aria-label="Stacki Studio">Studio stub</section>; }',
    }));
  },
};
const bundled = esbuild.build({
  // The Settings dialog and the role store it reads, from one bundle so a test can set the role.
  stdin: {
    contents: [
      "export { default, openAppSettings } from './src/app/settings/Settings';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { ADMIN_VIEW, DEFAULT_PROJECT_ROLES, roleViewOf } from './shared/properties/projectRoles';",
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
  plugins: [stubs],
  logLevel: 'silent',
});
const tabsOutput = repoPath('node_modules/.stacki-test/settings-tab-model.cjs');
esbuild.buildSync({
  entryPoints: [repoPath('src/app/settings/settingsTab.ts')],
  outfile: tabsOutput,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
const menuListeners = new Map();
window.avb = {
  onMenu: (name, callback) => {
    menuListeners.set(name, callback);
    return () => menuListeners.delete(name);
  },
  settings: async () => ({ sound: false, usageCountsEnabled: true }),
  setPreference: async (input) => ({ sound: input.enabled, usageCountsEnabled: true, saved: true }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let settings;
test.before(async () => {
  await bundled;
  settings = require(output);
});
const model = require(tabsOutput);

const tabs = () => [...document.querySelectorAll('[role="tab"]')];
const selectedTab = () => document.querySelector('[role="tab"][aria-selected="true"]');
const visiblePanel = () => [...document.querySelectorAll('[role="tabpanel"]')].filter((panel) => !panel.hidden);
const tab = (label) => tabs().find((item) => item.textContent.trim() === label);
const closeButton = () => document.querySelector('[aria-label="Close settings"]');

let root;
// A project is open unless the test says otherwise; `undefined` is a real value here.
async function mount(options = { projectPath: '/project' }) {
  const projectPath = options.projectPath;
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(settings.default, { projectPath, previewURL: undefined })));
}
async function unmount() {
  await act(async () => root.unmount());
}
async function close() {
  await act(async () => closeButton().click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.querySelector('.app-settings') === null, 'Settings closed');
}
const pressKey = (target, key) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

test('the tabs show their own panel and carry tab semantics', async () => {
  localStorage.clear();
  await mount();
  await act(async () => menuListeners.get('settings')());
  assert.equal(document.getElementById('app-settings-title').textContent, 'Settings');
  assert.ok(closeButton(), 'the close button stays');
  assert.ok(document.querySelector('.app-settings footer') === null, 'nothing is unsaved, so no action bar');
  assert.deepEqual(
    tabs().map((item) => item.textContent.trim()),
    ['Editor settings', 'Folders', 'CMS connections', 'Stacki Studio', 'Instructions', 'Audits', 'Roles'],
  );
  assert.equal(document.querySelector('[role="tablist"]').getAttribute('aria-orientation'), 'vertical');
  for (const item of tabs()) {
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    assert.ok(panel, `${item.textContent} controls a panel`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), item.id);
    assert.ok(item.querySelector('svg'), `${item.textContent} has an icon`);
  }
  assert.equal(tab('Stacki Studio').querySelector('svg').getAttribute('viewBox'), '0 0 458 458', 'the Studio tab shows the Stacki mark');
  assert.equal(selectedTab().textContent.trim(), 'Editor settings', 'opens on the first tab with nothing remembered');
  assert.equal(visiblePanel().length, 1, 'one panel shows at a time');
  assert.match(visiblePanel()[0].textContent, /Interface sounds/);
  assert.match(visiblePanel()[0].textContent, /Anonymous usage counts/);

  await act(async () => tab('Folders').click());
  assert.equal(visiblePanel()[0].textContent, 'Folders stub');
  await act(async () => tab('CMS connections').click());
  assert.equal(selectedTab().textContent.trim(), 'CMS connections');
  assert.equal(visiblePanel()[0].textContent, 'CMS stub');
  await act(async () => tab('Stacki Studio').click());
  assert.equal(visiblePanel()[0].textContent, 'Studio stub');
  assert.equal(tabs().filter((item) => item.tabIndex === 0).length, 1, 'only the selected tab is in the tab order');
  assert.equal(tab('Stacki Studio').tabIndex, 0);
  await close();
  await unmount();
});

test('without a project the Folders, CMS and Studio tabs say what to do', async () => {
  localStorage.clear();
  await mount({ projectPath: undefined });
  await act(async () => settings.openAppSettings('folders'));
  assert.equal(visiblePanel()[0].textContent, 'Open a project to choose its folders.');
  await act(async () => settings.openAppSettings('cms'));
  assert.equal(visiblePanel()[0].textContent, 'Open a project to connect a CMS.');
  await act(async () => tab('Stacki Studio').click());
  assert.equal(visiblePanel()[0].textContent, 'Open a project to add Stacki Studio.');
  await close();
  await unmount();
});

test('the arrow keys move between tabs and wrap', async () => {
  localStorage.clear();
  await mount();
  await act(async () => settings.openAppSettings());
  tab('Editor settings').focus();
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Folders');
  assert.equal(document.activeElement, selectedTab(), 'focus follows the selection');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'CMS connections');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Stacki Studio');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Instructions');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Audits');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Roles');
  await pressKey(document.activeElement, 'ArrowDown');
  assert.equal(selectedTab().textContent.trim(), 'Editor settings', 'down from the last wraps to the first');
  await pressKey(document.activeElement, 'ArrowUp');
  assert.equal(selectedTab().textContent.trim(), 'Roles', 'up from the first wraps to the last');
  await pressKey(document.activeElement, 'Home');
  assert.equal(selectedTab().textContent.trim(), 'Editor settings');
  await pressKey(document.activeElement, 'End');
  assert.equal(selectedTab().textContent.trim(), 'Roles');
  await pressKey(document.activeElement, 'a');
  assert.equal(selectedTab().textContent.trim(), 'Roles', 'other keys leave the selection alone');
  await close();
  await unmount();
});

test('Settings reopens on the last tab, and the CMS rail opens CMS connections', async () => {
  localStorage.clear();
  await mount();
  await act(async () => settings.openAppSettings());
  await act(async () => tab('Stacki Studio').click());
  await close();
  assert.equal(localStorage.getItem('stacki.settings.tab'), 'studio');

  await act(async () => menuListeners.get('settings')());
  assert.equal(selectedTab().textContent.trim(), 'Stacki Studio', 'File > Settings opens on the remembered tab');
  await close();
  await act(async () => settings.openAppSettings());
  assert.equal(selectedTab().textContent.trim(), 'Stacki Studio', 'the title bar gear does too');
  await close();

  // The CMS rail's connect action (AppShell) opens on CMS connections whatever was last used.
  await act(async () => settings.openAppSettings('cms'));
  assert.equal(selectedTab().textContent.trim(), 'CMS connections');
  assert.equal(visiblePanel()[0].textContent, 'CMS stub');
  await close();
  await unmount();

  const shell = fs.readFileSync(repoPath('src/app/shell/AppShell.tsx'), 'utf8');
  assert.match(shell, /onConnect=\{\(\) => openAppSettings\('cms'\)\}/, 'the CMS rail asks for the CMS tab');
});

test('a stored tab is parsed, and storage failures fall back to the first tab', () => {
  assert.equal(model.parseStoredSettingsTab('cms'), 'cms');
  assert.equal(model.parseStoredSettingsTab('studio'), 'studio');
  for (const bad of [JSON.parse('null'), undefined, '', 'top', 'CMS', 'editor ', 3, {}]) {
    assert.equal(model.parseStoredSettingsTab(bad), 'editor', `${String(bad)} is not a tab`);
  }
  const original = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage blocked');
    },
  });
  try {
    assert.equal(model.loadSettingsTab(), 'editor');
    assert.doesNotThrow(() => model.saveSettingsTab('cms'));
  } finally {
    Object.defineProperty(global, 'localStorage', original);
  }
  assert.throws(() => model.saveSettingsTab('top'), /Assertion failed: A Settings tab is one of SETTINGS_TABS/);
  assert.equal(model.settingsTabAfterKey('editor', 'ArrowRight'), 'folders', 'the narrow tab row moves sideways');
  assert.equal(model.settingsTabAfterKey('editor', 'ArrowLeft'), 'roles');
  assert.equal(model.settingsTabAfterKey('editor', 'ArrowLeft', ['editor', 'roles']), 'roles', 'only the shown tabs are stepped through');
  assert.equal(model.settingsTabAfterKey('editor', 'Enter'), undefined);
});

test('a role sees only the Settings tabs it is allowed, and Roles always', async () => {
  localStorage.clear();
  settings.setActualRole(settings.roleViewOf(settings.DEFAULT_PROJECT_ROLES, 'client'));
  await mount();
  await act(async () => settings.openAppSettings('studio'));
  assert.deepEqual(
    tabs().map((item) => item.textContent.trim()),
    ['Editor settings', 'Roles'],
  );
  assert.equal(selectedTab().textContent.trim(), 'Editor settings', 'a hidden tab opens on the first shown one');
  await close();
  await unmount();
  settings.setActualRole(settings.ADMIN_VIEW);
});

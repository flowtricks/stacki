// Goal: the Settings button sits at the rail's foot immediately before the AI chat button, carries the
// tooltip text "Settings", opens the project Settings panel, is hidden from a role without the panel
// (the built-in client by default), and stays when there is no AI button. The Instructions have no rail button
// of their own: they are a view inside Settings, so ⌥I opens Settings at them, and a role granted only
// `panel:instructions` still gets the Settings button. The shortcut table has no duplicate chord; each of AI chat
// (⌥A), Secrets (⌥R), MCP (⌥M) and Instructions (⌥I) routes by role, toggles like the panels, and stays quiet in a field.
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
      "export { RAIL_SHORTCUTS, PREVIEW_SHORTCUT, PULL_SHORTCUT, isPullChord, railActionOf, railShortcutLabel } from './src/app/railShortcuts';",
      "export { publishSettingsView } from './src/lib/settingsSections';",
      "export { ADMIN_VIEW, roleViewOf, DEFAULT_PROJECT_ROLES, parseProjectRoles } from './shared/properties/projectRoles';",
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
    root.render(
      React.createElement(rail.LeftRail, {
        projectPath: '/project',
        onSelect: (tab) => selected.push(tab),
        onOpenSettings: (target) => selected.push(`settings:${target}`),
        componentOpen: false,
        aiButton,
      }),
    ),
  );
  await settle();
}
const labels = () => [...document.querySelectorAll('.rail-btn')].map((button) => button.getAttribute('aria-label'));

test('Settings is the button immediately before AI chat, at the foot of the rail', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  await mount(true);
  const all = labels();
  assert.equal(all.at(-1), 'AI chat (⌥A)');
  assert.match(all.at(-2), /^Settings \(/, 'Settings immediately before AI chat');
  const anchor = document.querySelector('.rail-anchor');
  assert.deepEqual(
    // The foot's list may also hold panels a person moved or the default order puts there (Style selectors, Audits).
    [...anchor.querySelectorAll('.rail-btn')].map((button) => button.getAttribute('aria-label')?.split(' (')[0]).slice(-2),
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
  assert.equal(labels().at(-1), 'AI chat (⌥A)');
  await act(async () => root.unmount());
});

test('the Instructions have no rail button; ⌥I opens Settings at them', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  selected.length = 0;
  await mount(true);
  assert.ok(!labels().some((label) => label?.startsWith('Instructions')), 'no Instructions button');
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyI', altKey: true, bubbles: true })));
  assert.deepEqual(selected, ['settings:instructions']);
  await act(async () => root.unmount());
});

test('a role with only panel:instructions gets the Settings button and the shortcut; one with neither gets neither', async () => {
  const roles = rail.parseProjectRoles({
    version: 1,
    defaultRole: 'client',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'client', name: 'Client', members: ['acme'] },
      { id: 'docs', name: 'Docs', members: ['sam'], access: ['panel:instructions'] },
    ],
  });
  rail.setActualRole(rail.roleViewOf(roles, 'docs'));
  selected.length = 0;
  await mount(true);
  assert.match(labels().at(-2), /^Settings/);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyI', altKey: true, bubbles: true })));
  assert.deepEqual(selected, ['settings:instructions']);
  await act(async () => root.unmount());
  rail.setActualRole(rail.roleViewOf(roles, 'client'));
  selected.length = 0;
  await mount(true);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyI', altKey: true, bubbles: true })));
  assert.deepEqual(selected, [], 'no access, no shortcut');
  await act(async () => root.unmount());
});

const press = (init) => act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const chordsOf = () => rail.RAIL_SHORTCUTS.map((shortcut) => rail.railShortcutLabel(shortcut));

// The owner's chords, one per panel and Settings view. Properties alone is a plain letter.
const CHORDS = {
  elements: '⌥E',
  pages: '⌥P',
  navigator: '⌥N',
  assets: '⌥K',
  cms: '⌥D',
  variables: '⌥V',
  history: '⌥G',
  components: '⌥C',
  properties: 'K',
  apps: '⌥B',
  code: '⌥O',
  files: '⌥F',
  selectors: '⌥S',
  audits: '⌥U',
  projectSettings: '⌥Z',
  ai: '⌥A',
  secrets: '⌥R',
  mcp: '⌥M',
  instructions: '⌥I',
  agents: '⌥Q',
};

test('no two chords are the same, the preview toggle among them', () => {
  const chords = [...chordsOf(), rail.railShortcutLabel(rail.PREVIEW_SHORTCUT), rail.railShortcutLabel(rail.PULL_SHORTCUT)];
  assert.equal(new Set(chords).size, chords.length, `no chord twice: ${chords.join(' ')}`);
  assert.equal(rail.railShortcutLabel(rail.PREVIEW_SHORTCUT), '⌥⇧P');
  assert.equal(rail.railShortcutLabel(rail.PULL_SHORTCUT), '⌥⇧G');
  const by = Object.fromEntries(rail.RAIL_SHORTCUTS.map((shortcut) => [shortcut.action, rail.railShortcutLabel(shortcut)]));
  assert.deepEqual(by, CHORDS);
});

test('each chord is matched on the physical key, and the old and modified presses open nothing', () => {
  const press = (code, fields = {}) =>
    rail.railActionOf({ altKey: true, shiftKey: false, metaKey: false, ctrlKey: false, key: 'Dead', code, ...fields })?.action;
  for (const [action, chord] of Object.entries(CHORDS)) {
    if (chord.startsWith('⌥')) {
      assert.equal(press(`Key${chord.slice(1)}`), action, chord);
      assert.equal(press(`Key${chord.slice(1)}`, { shiftKey: true }), undefined, `⇧ with ${chord} is another chord`);
      assert.equal(press(`Key${chord.slice(1)}`, { ctrlKey: true }), undefined, 'AltGr is Ctrl+Alt: it types');
      assert.equal(press(`Key${chord.slice(1)}`, { metaKey: true }), undefined);
    }
  }
  // The plain and ⇧ letters the panels used to have are not kept as aliases.
  for (const key of ['a', 'p', 'z', 'j', 'c', 'g', 'e']) {
    assert.equal(press(`Key${key.toUpperCase()}`, { altKey: false, key }), undefined, key);
  }
  assert.equal(press('KeyA', { altKey: false, shiftKey: true, key: 'A' }), undefined, '⇧A');
  assert.equal(press('KeyK', { altKey: false, key: 'k' }), 'properties');
});

test('the pull chord is its own: the rail does not take it, and it takes no other press', () => {
  const press = { altKey: true, shiftKey: true, metaKey: false, ctrlKey: false, key: '˝', code: 'KeyG' };
  assert.equal(rail.isPullChord(press), true);
  assert.equal(rail.railActionOf(press), undefined);
  for (const other of [{ shiftKey: false }, { altKey: false }, { metaKey: true }, { ctrlKey: true }, { code: 'KeyP' }]) {
    assert.equal(rail.isPullChord({ ...press, ...other }), false, JSON.stringify(other));
  }
});

test('the canvas frames forward exactly the table’s ⌥ letters', () => {
  const source = fs.readFileSync(repoPath('electron/preload/frameDesign.ts'), 'utf8');
  const written = /const panelCodes = '([^']+)';/.exec(source)?.[1]?.split(' ') ?? [];
  const table = rail.RAIL_SHORTCUTS.filter((shortcut) => shortcut.alt).map((shortcut) => `Key${shortcut.letter.toUpperCase()}`);
  assert.deepEqual([...written].sort(), table.sort());
});

test('⌥A toggles the AI chat, ⌥R and ⌥M open Settings at Secrets and MCP, and a role without them does nothing', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  selected.length = 0;
  await mount(true);
  await press({ code: 'KeyA', altKey: true });
  await press({ code: 'KeyR', altKey: true });
  await press({ code: 'KeyM', altKey: true });
  assert.deepEqual(selected, ['ai', 'settings:secrets', 'settings:mcp']);
  await act(async () => root.unmount());
  // Instructions-only: ⌥I works; ⌥R and ⌥M do not (Secrets and MCP need panel:projectSettings).
  const roles = rail.parseProjectRoles({
    version: 1,
    defaultRole: 'client',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'client', name: 'Client', members: ['acme'] },
      { id: 'docs', name: 'Docs', members: ['sam'], access: ['panel:instructions'] },
      { id: 'ops', name: 'Ops', members: ['kim'], access: ['panel:projectSettings'] },
    ],
  });
  rail.setActualRole(rail.roleViewOf(roles, 'docs'));
  selected.length = 0;
  await mount(false);
  for (const code of ['KeyI', 'KeyR', 'KeyM', 'KeyQ', 'KeyA']) {
    await press({ code, altKey: true });
  }
  assert.deepEqual(selected, ['settings:instructions', 'settings:agents'], 'only the views the role may open, and no AI button means no AI key');
  await act(async () => root.unmount());
  rail.setActualRole(rail.roleViewOf(roles, 'ops'));
  selected.length = 0;
  await mount(false);
  for (const code of ['KeyI', 'KeyR', 'KeyM', 'KeyQ']) {
    await press({ code, altKey: true });
  }
  assert.deepEqual(selected, ['settings:secrets', 'settings:mcp']);
  await act(async () => root.unmount());
});

test('the same chord again, with that view showing, toggles Settings closed; a field keeps its keys', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  selected.length = 0;
  const container = document.createElement('div');
  document.body.append(container);
  const own = createRoot(container);
  const render = (active) =>
    act(async () =>
      own.render(
        React.createElement(rail.LeftRail, {
          active,
          projectPath: '/project',
          onSelect: (tab) => selected.push(tab),
          onOpenSettings: (target) => selected.push(`settings:${target}`),
          componentOpen: false,
        }),
      ),
    );
  await render('projectSettings');
  rail.publishSettingsView('secrets');
  await press({ code: 'KeyR', altKey: true });
  assert.deepEqual(selected, ['projectSettings'], 'Secrets showing: ⌥R toggles the panel closed');
  selected.length = 0;
  await press({ code: 'KeyM', altKey: true });
  assert.deepEqual(selected, ['settings:mcp'], 'another view: ⌥M opens it');
  selected.length = 0;
  rail.publishSettingsView(undefined);
  await press({ code: 'KeyR', altKey: true });
  assert.deepEqual(selected, ['settings:secrets'], 'the root showing: ⌥R opens Secrets');
  selected.length = 0;
  const field = document.createElement('input');
  document.body.append(field);
  await act(async () => field.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyR', altKey: true, bubbles: true, cancelable: true })));
  assert.deepEqual(selected, [], 'typing in a field: no shortcut');
  field.remove();
  await act(async () => own.unmount());
});

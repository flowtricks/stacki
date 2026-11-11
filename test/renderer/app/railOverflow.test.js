// Goal: the left rail shows the apps a role pinned (`pinnedApps`) as their own
// buttons below the panels, and on a short window moves what does not fit into a
// "More" menu without ever hiding the active item while something else can go.
// The pure `railOverflow` decides which buttons fit for any height: everything fits
// at the exact threshold; past it pinned apps leave first, the last pinned first,
// then panels from the bottom up; the active item stays; with no room at all every
// item is in the menu. The real LeftRail then renders a role's pins in pin order
// (uninstalled and inaccessible pins ignored, a badge on the button, the app name
// as its label), follows a ResizeObserver to collapse buttons into More, lists
// hidden panels there with their icons, labels and shortcuts, keeps shortcuts of
// hidden panels working, and opens a pinned app when clicked. Studio's EditorRail
// does the same, with its AI button anchored at the foot.
// Method: call `railOverflow` across a sweep of heights and pin exact cases, then
// bundle the real LeftRail with the real role store, badges and apps runtime
// through esbuild, mount it in jsdom with a fake `window.avb.listApps`, a stub
// ResizeObserver the test fires by hand and a rail height the test sets. Studio's
// rail is bundled the same way, its vendored imports read from the sources the
// vendored copy is made of.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/rail-overflow.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as LeftRail } from './src/app/LeftRail';",
      "export { railOverflow } from './src/app/railOverflow';",
      "export { pinnedRailApps } from './src/app/railApps';",
      "export { setActualRole, setViewAs } from './src/lib/currentRole';",
      "export { appBadges } from './src/features/apps/appBadges';",
      "export { runningApps, resetAppsRuntime } from './src/features/apps/appsRuntime';",
      "export { parseProjectRoles, roleViewOf, ADMIN_VIEW } from './shared/properties/projectRoles';",
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

// Studio reaches shared code through a generated copy (studio/vendor); here it is the source that copy is made of.
const ROOT = repoPath('package.json').replace(/package\.json$/, '');
const studioOutput = repoPath('node_modules/.stacki-test/rail-overflow-studio.cjs');
// Plugins need the asynchronous build; the Studio test awaits it.
const studioBuilt = esbuild.build({
  stdin: {
    contents: [
      "export { EditorRail } from './studio/src/app/EditorRail';",
      "export { setStudioRoles } from './studio/src/features/roles/roleStore';",
      "export { parseProjectRoles, roleViewOf } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: studioOutput,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
  plugins: [
    {
      name: 'vendor-sources',
      setup(context) {
        context.onResolve({ filter: /\/vendor\/stacki\// }, async (args) => {
          const relative = args.path.slice(args.path.indexOf('/vendor/stacki/') + '/vendor/stacki/'.length);
          return context.resolve(`./${relative}`, { resolveDir: ROOT, kind: args.kind });
        });
      },
    },
  ],
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

// The rail's box: the test sets its height and fires the observer, as a window resize would.
let railHeightPx = 1000;
const observers = new Set();
global.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
};
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return this.classList.contains('rail') ? railHeightPx : 0;
  },
});

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const rail = require(output);

const PANELS = ['pages', 'navigator', 'components', 'assets', 'cms', 'variables', 'selectors', 'code', 'history', 'apps'].map((id) => ({ id, group: 'panel' }));
const APPS = ['app:a', 'app:b', 'app:c'].map((id) => ({ id, group: 'app' }));
const ITEMS = [...PANELS, ...APPS];
const ROOM = { itemPx: 36, separatorPx: 9 };
const room = (availablePx) => ({ ...ROOM, availablePx });

test('everything fits at the exact threshold, and pinned apps leave first, the last pinned first', () => {
  const allPx = ITEMS.length * ROOM.itemPx + ROOM.separatorPx;
  assert.deepEqual(rail.railOverflow(ITEMS, room(allPx), undefined).hidden, [], 'the threshold itself fits');
  const short = rail.railOverflow(ITEMS, room(allPx - 1), undefined);
  assert.deepEqual(short.hidden, ['app:b', 'app:c'], 'one pixel short, More takes a row: two apps leave, the last pinned first');
  assert.deepEqual(short.visible, [...PANELS.map((item) => item.id), 'app:a']);
  // Without any app the separator goes too, which frees its row's share.
  const panelsOnly = rail.railOverflow(ITEMS, room(PANELS.length * ROOM.itemPx), undefined);
  assert.deepEqual(panelsOnly.hidden, ['apps', 'app:a', 'app:b', 'app:c'], 'the menu lists in rail order');
  assert.deepEqual(rail.railOverflow(PANELS, room(4 * ROOM.itemPx), undefined).hidden, ['assets', 'cms', 'variables', 'selectors', 'code', 'history', 'apps']);
});

test('the active item stays while another can leave; with no room at all everything is in the menu', () => {
  const allPx = ITEMS.length * ROOM.itemPx + ROOM.separatorPx;
  assert.deepEqual(rail.railOverflow(ITEMS, room(allPx - 1), 'app:c').hidden, ['app:a', 'app:b'], 'the shown app swaps in for an earlier pin');
  const tiny = rail.railOverflow(ITEMS, room(2 * ROOM.itemPx), 'apps');
  assert.deepEqual(tiny.visible, ['apps'], 'one row for the active panel, one for More');
  assert.equal(tiny.hidden.length, ITEMS.length - 1);
  const none = rail.railOverflow(ITEMS, room(ROOM.itemPx - 1), 'pages');
  assert.deepEqual(none.visible, [], 'not even More fits beside it');
  assert.ok(none.hidden.includes('pages'), 'the active item is in the menu, which reads as active');
  assert.throws(() => rail.railOverflow([...PANELS, PANELS[0]], room(1000), undefined), /Rail ids are unique/);
});

test('across every height the layout is a partition that fits, never hides more as it grows, and keeps the active item', () => {
  let previousHidden = ITEMS.length;
  for (let availablePx = 0; availablePx <= 600; availablePx += 3) {
    const layout = rail.railOverflow(ITEMS, room(availablePx), 'code');
    assert.equal(layout.visible.length + layout.hidden.length, ITEMS.length, `${availablePx}px: every item is somewhere`);
    assert.deepEqual([...layout.visible, ...layout.hidden].sort(), ITEMS.map((item) => item.id).sort());
    const order = ITEMS.map((item) => item.id);
    assert.deepEqual(
      layout.visible,
      order.filter((id) => layout.visible.includes(id)),
      'visible items keep rail order',
    );
    if (layout.hidden.length > 0) {
      const apps = layout.visible.filter((id) => id.startsWith('app:')).length;
      const panels = layout.visible.length - apps;
      const usedPx = (layout.visible.length + 1) * ROOM.itemPx + (apps > 0 && panels > 0 ? ROOM.separatorPx : 0);
      assert.ok(layout.visible.length === 0 || usedPx <= availablePx, `${availablePx}px: what shows fits with More`);
      // A panel leaves only once every app has.
      if (layout.hidden.some((id) => !id.startsWith('app:'))) {
        assert.equal(apps, 0, `${availablePx}px: no app shows while a panel is hidden`);
      }
    }
    if (layout.visible.length > 0) {
      assert.ok(layout.visible.includes('code'), `${availablePx}px: the active panel shows`);
    }
    assert.ok(layout.hidden.length <= previousHidden, `${availablePx}px: more room never hides more`);
    previousHidden = layout.hidden.length;
  }
});

// The rail, mounted.
const manifest = (id, name) => ({
  manifestVersion: 1,
  id,
  name,
  version: '1.0.0',
  description: name,
  entry: 'index.html',
  capabilities: ['selection'],
  window: { mode: 'popup', widthPx: 300, heightPx: 300 },
  settings: [],
  secretsAllowlist: [],
});
const summary = (id, name) => ({
  manifest: manifest(id, name),
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'file', fileName: `${id}.zip` } },
});
let installed = [summary('seo', 'SEO'), summary('feedback', 'Feedback'), summary('secret', 'Secret')];
window.avb = { listApps: async () => ({ ok: true, value: installed }) };

const rolesFile = rail.parseProjectRoles({
  version: 1,
  roles: [
    { id: 'admin', name: 'Admin', members: ['owner'], pinnedApps: ['secret'] },
    {
      id: 'writer',
      name: 'Writer',
      members: ['sam'],
      access: ['panel:pages', 'panel:apps', 'app:seo', 'app:feedback'],
      pinnedApps: ['feedback', 'gone', 'secret', 'seo'],
    },
  ],
});

let root;
const selected = [];
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
async function mount(active) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(React.createElement(rail.LeftRail, { active, projectPath: '/project', onSelect: (tab) => selected.push(tab), componentOpen: false })),
  );
  await settle();
}
async function resize(heightPx) {
  railHeightPx = heightPx;
  await act(async () => {
    for (const observer of observers) {
      observer.callback([]);
    }
  });
}
const labels = () => [...document.querySelectorAll('.rail > button')].map((button) => button.getAttribute('aria-label'));

test('the rail draws a role’s pins in pin order, after a line, with their badge, and only what the role may use', async () => {
  rail.setActualRole(rail.roleViewOf(rolesFile, 'writer'));
  await mount('pages');
  assert.deepEqual(labels(), ['Pages (P)', 'Apps (E)', 'Feedback', 'SEO'], 'uninstalled and inaccessible pins are skipped');
  assert.ok(document.querySelector('.rail-separator'), 'a line separates panels and apps');
  assert.equal(document.querySelector('.rail-more') ?? undefined, undefined, 'a tall rail has no More button');
  await act(async () => rail.appBadges.set('seo', 4));
  const seo = document.querySelector('button[aria-label="SEO"]');
  assert.equal(seo.querySelector('.apps-rail-count')?.textContent, '4', 'the app badge shows on its pinned button');
  assert.ok(seo.querySelector('.apps-tile'), 'the button draws the app tile');
  await act(async () => rail.appBadges.set('seo', 0));

  await act(async () => seo.click());
  assert.deepEqual(
    rail.runningApps().map((entry) => entry.app.manifest.id),
    ['seo'],
    'clicking a pin launches the app in its preferred mode',
  );
  rail.resetAppsRuntime();

  // Admin pins too, and sees its own.
  await act(async () => rail.setActualRole(rail.roleViewOf(rolesFile, 'admin')));
  await settle();
  // The panels after Apps (Instructions, Audits) come before the line; the admin's own pin ends the rail.
  assert.equal(labels().at(-1), 'Secret');
  assert.ok(labels().includes('Apps (E)'));
  await act(async () => root.unmount());
});

test('a short rail collapses into More, keeps the active panel, and hidden shortcuts still work', async () => {
  rail.setActualRole(rail.roleViewOf(rolesFile, 'admin'));
  selected.length = 0;
  railHeightPx = 1000;
  await mount('code');
  const tall = labels();
  assert.equal(tall.length, 13, 'twelve panels without Properties, then the pinned app');
  // Room for four rows: three buttons and More. Desktop's rail has 10px of top padding in CSS; jsdom has none.
  await resize(4 * 36 - 4);
  assert.deepEqual(labels(), ['Pages (P)', 'Navigator (Z)', 'Code (C)', 'More']);
  const more = document.querySelector('button.rail-more');
  assert.ok(!more.classList.contains('on'), 'the active panel shows, so More is not active');
  await act(async () => more.click());
  await settle();
  const rows = [...document.querySelectorAll('.more-menu-item')].map((row) => row.textContent);
  assert.deepEqual(rows, ['Components⇧A', 'AssetsJ', 'CMS⌥C', 'Variables⌥V', 'Style selectorsG', 'Git⌥H', 'AppsE', 'Instructions⌥I', 'Audits⌥A', 'SSecret']);
  assert.ok(document.querySelector('.more-menu-item svg'), 'rows show their icons');
  await act(async () => [...document.querySelectorAll('.more-menu-item')][1].click());
  await settle();
  assert.deepEqual(selected, ['assets'], 'a row selects its panel');
  // A hidden panel's shortcut still opens it.
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })));
  assert.deepEqual(selected, ['assets', 'assets']);
  // Growing back restores every button.
  await resize(1000);
  assert.deepEqual(labels(), tall);
  await act(async () => root.unmount());
});

test('with no room for the active panel, More reads as active', async () => {
  rail.setActualRole(rail.ADMIN_VIEW);
  await mount('history');
  await resize(20);
  assert.deepEqual(labels(), ['More']);
  assert.ok(document.querySelector('button.rail-more').classList.contains('on'), 'the active panel is inside More');
  await act(async () => root.unmount());
});

test('pinnedRailApps keeps pin order and drops what the rail must ignore', () => {
  const writer = rail.roleViewOf(rolesFile, 'writer');
  assert.deepEqual(
    rail.pinnedRailApps(writer, installed).map((app) => app.manifest.id),
    ['feedback', 'seo'],
  );
  installed = [];
  assert.deepEqual(rail.pinnedRailApps(writer, installed), [], 'nothing installed shows nothing');
});

test('Studio’s rail shows the role’s pins and collapses into More above its anchored AI button', async () => {
  await studioBuilt;
  const studio = require(studioOutput);
  installed = [summary('seo', 'SEO'), summary('secret', 'Secret')];
  const file = studio.parseProjectRoles({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['owner'], pinnedApps: ['secret', 'seo'] }] });
  studio.setStudioRoles(file, studio.roleViewOf(file, 'admin'));
  railHeightPx = 1000;
  const container = document.createElement('div');
  document.body.append(container);
  const studioRoot = createRoot(container);
  const toggled = [];
  await act(async () =>
    studioRoot.render(
      React.createElement(studio.EditorRail, { panel: 'pages', componentOpen: false, projectPath: 'studio', toggle: (next) => toggled.push(next) }),
    ),
  );
  await settle();
  const studioLabels = () => [...container.querySelectorAll('.rail > button')].map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(studioLabels().slice(-4), ['Apps', 'Secret', 'SEO', 'AI chat'], 'pins in pin order, AI at the foot');
  // Room for the AI button and four rows: three buttons and More.
  await resize(5 * 36 - 4);
  assert.deepEqual(studioLabels(), ['Pages', 'Navigator', 'Components', 'More', 'AI chat'], 'the active panel stays, the AI button keeps its place');
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })));
  assert.deepEqual(toggled, ['assets'], 'a hidden panel’s shortcut still works');
  await act(async () => studioRoot.unmount());
});

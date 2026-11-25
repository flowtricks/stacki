// Goal: a person can drag the rail's buttons into any order and between the top and bottom lists, and the order
// follows them into every project. A press that moves under six pixels is still a click and opens its panel;
// past it, the button keeps its place dimmed, a ghost and an insertion line show the slot, and a release over
// the rail drops there (including into an empty bottom list). Escape, a release outside the rail and a lost
// capture cancel. Alt+arrows on a focused button move it too and announce the new place. The order is read
// before the first frame, survives a remount and a project switch, keeps a role-hidden button's place, never
// disturbs the active highlight or the shortcuts, and is kept only in local storage: nothing is written to a
// project directory or through the app's file API, and the stored value names no project.
// Method: bundle the real LeftRail with the real role store, mount it in jsdom with a synthetic layout (rows at
// fixed positions) and a recording `window.avb`, drive it with real pointer, keyboard and contextmenu events,
// and read the DOM and localStorage after each step. The rail's overflow observer is absent, so every button shows.
// The Settings tests mount the rail beside the Settings panel's root rows (SettingsRailRows), the list the panel
// draws, at a fixed box beside the rail, and drag between the two: a rail button into Settings (on the Settings
// button, and between rows), a row out onto the rail, rows reordered, and the same by keyboard and menu. Every
// item stays in exactly one place.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');
const { measureSpeedFactor } = loadRenderer('test/helpers/scaleFixtures.ts');

const output = repoPath('node_modules/.stacki-test/rail-reorder.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as LeftRail } from './src/app/LeftRail';",
      "export { RailOrderSetting } from './src/app/settings/RailOrderSetting';",
      "export { SettingsRailRows } from './src/app/SettingsRailRows';",
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
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'StorageEvent',
  'getComputedStyle',
  'localStorage',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const apiCalls = [];
window.avb = new Proxy(
  { listApps: async () => ({ ok: true, value: [] }) },
  {
    get: (target, name) =>
      name in target
        ? target[name]
        : (...args) => {
            apiCalls.push(String(name));
            return Promise.resolve({ ok: true, value: undefined });
          },
  },
);

// A fixed layout: the rail is 44 x 800; top buttons start at 10 and step 36; the bottom list ends 10 above the foot.
const RAIL = { left: 0, right: 44, top: 0, bottom: 800 };
const box = (top, height) => ({ left: 6, right: 38, top, bottom: top + height, width: 32, height, x: 6, y: top, toJSON() {} });
// The Settings panel's root list sits beside the rail, 50 to 300 across and 100 to 400 down; its rows step 36 from 110.
const SETTINGS_LIST = { left: 50, right: 300, top: 100, bottom: 400 };
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.dataset.railSettingsList !== undefined) {
    return { ...SETTINGS_LIST, width: 250, height: 300, x: 50, y: 100, toJSON() {} };
  }
  if (this.dataset.railGroup === 'settings') {
    const index = [...this.closest('[data-rail-settings-list]').querySelectorAll('[data-rail-group="settings"]')].indexOf(this);
    return { left: 50, right: 300, top: 110 + 36 * index, bottom: 140 + 36 * index, width: 250, height: 30, x: 50, y: 110 + 36 * index, toJSON() {} };
  }
  if (this.classList.contains('rail')) {
    return { ...RAIL, width: 44, height: 800, x: 0, y: 0, toJSON() {} };
  }
  const group = this.dataset.railGroup;
  const rail = this.closest('.rail');
  if (group === 'top') {
    return box(10 + 36 * [...rail.querySelectorAll('[data-rail-group="top"]')].indexOf(this), 32);
  }
  const bottom = rail === null ? [] : [...rail.querySelectorAll('[data-rail-group="bottom"]')];
  const start = 800 - 10 - (bottom.length * 36 - 4);
  if (group === 'bottom') {
    return box(start + 36 * bottom.indexOf(this), 32);
  }
  if (this.classList.contains('rail-slot-empty')) {
    return box(758, 32);
  }
  if (this.classList.contains('rail-anchor')) {
    return box(bottom.length === 0 ? 758 : start, bottom.length === 0 ? 42 : bottom.length * 36 + 6);
  }
  return box(0, 0);
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const rail = require(output);
const STORAGE_KEY = 'stacki.rail.order';

let selected = [];
let root;
async function mount(options = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(rail.LeftRail, {
        projectPath: options.projectPath ?? '/project-a',
        onSelect: (tab) => selected.push(tab),
        onOpenSettings: () => {},
        componentOpen: false,
        aiButton: { active: false, onSelect: () => selected.push('ai') },
      }),
    ),
  );
}
async function unmount() {
  await act(async () => root.unmount());
  root = undefined;
  document.body.innerHTML = '';
}
const ids = (group) => [...document.querySelectorAll(`[data-rail-group="${group}"]`)].map((button) => button.dataset.railId);
const button = (id) => document.querySelector(`[data-rail-id="${id}"]`);
const stored = () => localStorage.getItem(STORAGE_KEY);
// Add elements leads the rail (src/app/railDefaults.ts), so Pages is the second button: 36px lower than the first.
const DEFAULT_TOP = ['elements', 'pages', 'navigator', 'assets', 'cms', 'variables', 'history', 'components', 'apps', 'code', 'files'];
const DEFAULT_BOTTOM = ['selectors', 'audits', 'projectSettings', 'ai'];

function pointer(target, type, x, y, extra = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'isPrimary', { value: true });
  Object.assign(event, extra);
  return act(async () => target.dispatchEvent(event));
}
const down = (id, y) => pointer(button(id), 'pointerdown', 20, y);
const move = (id, x, y) => pointer(button(id), 'pointermove', x, y);
const up = (id, x, y) => pointer(button(id), 'pointerup', x, y);
// A real release is followed by a click in the same task; the rail's flag for it lasts only that long.
const upAndClick = (id, x, y) =>
  act(async () => {
    const target = button(id);
    const event = new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'isPrimary', { value: true });
    target.dispatchEvent(event);
    target.click();
  });
const press = (target, key, init = {}) =>
  act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));

test.beforeEach(async () => {
  if (root !== undefined) {
    // A test that failed before it unmounted leaves its rail behind; it must not leak into the next.
    await act(async () => root.unmount());
    root = undefined;
    document.body.innerHTML = '';
  }
  rail.setActualRole(rail.ADMIN_VIEW);
  localStorage.clear();
  selected = [];
  apiCalls.length = 0;
});

test('the default order: Add elements and Pages to Code on top, then Style selectors, Audits, Settings and AI at the foot', async () => {
  await mount();
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.deepEqual(ids('bottom'), DEFAULT_BOTTOM);
  assert.ok(stored() === null, 'nothing is stored until a person arranges the rail');
  await unmount();
});

test('a press that moves under six pixels is a click: it opens the panel and reorders nothing', async () => {
  await mount();
  await down('navigator', 60);
  await move('navigator', 20, 64);
  assert.ok(document.querySelector('.rail-ghost') === null, 'no ghost under the threshold');
  await up('navigator', 20, 64);
  await act(async () => button('navigator').click());
  assert.deepEqual(selected, ['navigator']);
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.ok(stored() === null);
  await unmount();
});

test('dragging past the threshold shows a ghost and a line, dims the button, reorders on release and swallows the click', async (context) => {
  await mount();
  await down('pages', 62);
  await move('pages', 20, 76);
  await move('pages', 20, 136);
  assert.ok(document.querySelector('.rail-ghost'), 'a ghost follows the pointer');
  assert.ok(document.querySelector('.rail-drop-line'), 'a line shows the slot');
  assert.equal(button('pages').dataset.dragging, 'true', 'the dragged button keeps its place, dimmed');
  assert.deepEqual(ids('top'), DEFAULT_TOP, 'nothing moves until the drop');
  // The product clears its swallow-the-click flag with a zero-delay timer; the mocked clock runs it on demand instead of a guessed pause.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await upAndClick('pages', 20, 136);
  assert.deepEqual(ids('top').slice(0, 4), ['elements', 'navigator', 'assets', 'pages']);
  assert.ok(document.querySelector('.rail-ghost') === null);
  assert.deepEqual(selected, [], 'the click that ends a drag does not open the panel');
  await act(async () => context.mock.timers.tick(0));
  context.mock.timers.reset();
  await act(async () => button('pages').click());
  assert.deepEqual(selected, ['pages'], 'a later click does');
  assert.ok(stored().includes('"pages"'));
  await unmount();
});

test('dropping on the bottom group moves a button there, before the nearest slot', async () => {
  await mount();
  await down('code', ids('top').indexOf('code') * 36 + 26);
  await move('code', 20, 400);
  await move('code', 20, 770);
  await up('code', 20, 770);
  assert.ok(!ids('top').includes('code'));
  assert.deepEqual(ids('bottom'), ['selectors', 'audits', 'projectSettings', 'code', 'ai']);
  assert.equal(document.querySelector('.rail-anchor').children.length, 5);
  await unmount();
});

test('an empty bottom group is still a drop target', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, top: [...DEFAULT_TOP, ...DEFAULT_BOTTOM], bottom: [] }));
  await mount();
  assert.deepEqual(ids('bottom'), []);
  assert.ok(document.querySelector('.rail-anchor') === null);
  await down('pages', 62);
  await move('pages', 20, 76);
  await move('pages', 20, 780);
  assert.ok(document.querySelector('.rail-slot-empty'), 'a placeholder stands in for the empty list while dragging');
  await up('pages', 20, 780);
  assert.deepEqual(ids('bottom'), ['pages']);
  assert.ok(document.querySelector('.rail-slot-empty') === null);
  await unmount();
});

test('Escape cancels, and so does a release outside the rail', async () => {
  await mount();
  await down('pages', 62);
  await move('pages', 20, 136);
  await press(window, 'Escape');
  assert.ok(document.querySelector('.rail-ghost') === null, 'Escape ends the drag');
  await up('pages', 20, 136);
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  await down('pages', 62);
  await move('pages', 20, 136);
  await move('pages', 300, 136);
  assert.equal(document.querySelector('.rail-ghost').dataset.outside, 'true');
  assert.ok(document.querySelector('.rail-drop-line') === null, 'no slot outside the rail');
  await up('pages', 300, 136);
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.ok(stored() === null);
  await unmount();
});

test('the tooltip is hidden while dragging', async () => {
  await mount();
  await act(async () => button('pages').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  await down('pages', 62);
  await move('pages', 20, 136);
  assert.ok(document.querySelector('.rail-tooltip') === null);
  await press(window, 'Escape');
  await unmount();
});

test('Alt+arrows reorder a focused button, move it between lists, and announce the new place', async () => {
  await mount();
  button('pages').focus();
  await press(button('pages'), 'ArrowDown', { altKey: true });
  assert.deepEqual(ids('top').slice(0, 3), ['elements', 'navigator', 'pages']);
  assert.equal(document.activeElement, button('pages'), 'focus stays on the moved button');
  assert.match(document.querySelector('.rail-live').textContent, /^Pages: top group, position 3 of 11$/);
  await press(button('pages'), 'ArrowUp', { altKey: true });
  assert.deepEqual(ids('top').slice(0, 3), ['elements', 'pages', 'navigator']);
  await press(button('pages'), 'ArrowRight', { altKey: true });
  assert.deepEqual(ids('bottom'), ['pages', ...DEFAULT_BOTTOM]);
  assert.equal(document.activeElement, button('pages'), 'focus survives the move into the other list');
  assert.match(document.querySelector('.rail-live').textContent, /bottom group, position 1 of 5/);
  await press(button('pages'), 'ArrowLeft', { altKey: true });
  assert.equal(ids('top').at(-1), 'pages');
  const before = stored();
  // The first button cannot go higher.
  await press(button('elements'), 'ArrowUp', { altKey: true });
  assert.equal(stored(), before, 'a move that changes nothing stores nothing');
  await press(button('navigator'), 'ArrowDown');
  assert.equal(stored(), before, 'arrows without Alt do not move');
  await unmount();
});

test('the order is read before the first frame, survives a remount and a project switch', async () => {
  await mount({ projectPath: '/project-a' });
  await down('pages', 62);
  await move('pages', 20, 136);
  await up('pages', 20, 136);
  const arranged = ids('top');
  await unmount();
  await mount({ projectPath: '/project-b' });
  assert.deepEqual(ids('top'), arranged, 'the first render already holds the person order');
  assert.ok(!stored().includes('/project-'), 'the stored order names no project');
  await unmount();
});

test('another window changing the order updates this rail', async () => {
  await mount();
  const order = { version: 1, top: ['code', ...DEFAULT_TOP.filter((id) => id !== 'code')], bottom: ['ai', 'projectSettings'] };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: STORAGE_KEY })));
  assert.equal(ids('top')[0], 'code');
  assert.deepEqual(ids('bottom'), ['selectors', 'audits', 'ai', 'projectSettings'], 'ids the stored order lacks go where the default puts them');
  await unmount();
});

test('a role-hidden button keeps its place in the stored order, and the shortcuts and highlight do not care about order', async () => {
  await mount();
  await act(async () => {
    await press(button('projectSettings'), 'ArrowLeft', { altKey: true });
  });
  assert.equal(ids('top').at(-1), 'projectSettings');
  await unmount();
  rail.setActualRole(rail.roleViewOf(rail.DEFAULT_PROJECT_ROLES, 'client'));
  await mount();
  assert.ok(button('projectSettings') === null, 'a role without the panel has no button');
  await press(button('ai'), 'ArrowUp', { altKey: true });
  const kept = JSON.parse(stored());
  assert.ok(kept.top.includes('projectSettings') || kept.bottom.includes('projectSettings'), 'the hidden button is still in the stored order');
  assert.deepEqual(
    [...kept.top, ...kept.bottom].filter((id, index, all) => all.indexOf(id) !== index),
    [],
    'no id repeats',
  );
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyP', altKey: true, bubbles: true })));
  assert.deepEqual(selected.at(-1), 'pages', 'the ⌥P shortcut selects Pages wherever it sits');
  await unmount();
});

test('right-clicking a rail button opens nothing and is default-prevented', async () => {
  await mount();
  for (const id of ['code', 'pages']) {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => button(id).dispatchEvent(event));
    assert.equal(event.defaultPrevented, true, `${id}: no native context menu either`);
    assert.equal(document.querySelectorAll('[role="menu"], [role="menuitem"]').length, 0, `${id}: no popup opens`);
  }
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.deepEqual(ids('bottom'), DEFAULT_BOTTOM);
  await unmount();
});

test('nothing is written to a project: no file API call, and the only storage written is the rail order key', async () => {
  await mount();
  await down('pages', 62);
  await move('pages', 20, 136);
  await up('pages', 20, 136);
  await press(button('pages'), 'ArrowRight', { altKey: true });
  assert.deepEqual(apiCalls, [], 'the rail made no call through the app bridge');
  assert.deepEqual(
    Object.keys(localStorage).filter((key) => key.startsWith('stacki.rail')),
    [STORAGE_KEY],
  );
  assert.ok(!stored().includes('.stacki'));
  await unmount();
});

test('mounting with the AI button and the default order commits a few times, quickly, and keeps the anchored list last', async () => {
  // A render loop here once froze the process (an assertion printing a whole DOM); the bound makes it a plain failure.
  const commits = [];
  // Two seconds on the reference machine, scaled by how slow this process runs a fixed calibration workload.
  const mountMsMax = 2000 * measureSpeedFactor();
  const startedMs = performance.now();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        React.Profiler,
        { id: 'rail', onRender: () => commits.push(1) },
        React.createElement(rail.LeftRail, {
          projectPath: '/project-a',
          onSelect: () => {},
          onOpenSettings: () => {},
          componentOpen: false,
          aiButton: { active: false, onSelect: () => {} },
        }),
      ),
    ),
  );
  assert.ok(performance.now() - startedMs < mountMsMax, 'the mount finishes within two seconds, scaled to this machine');
  assert.ok(commits.length <= 5, `the rail committed ${commits.length} times`);
  const railElement = container.querySelector('.rail');
  assert.ok(railElement.lastElementChild === container.querySelector('.rail-anchor'), 'the anchored list is the last element');
  await unmount();
});

test('Settings shows the Sidebar icon order row: absent at the default, live after a drag, gone after a reset the rail at once', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        undefined,
        React.createElement(rail.LeftRail, {
          projectPath: '/project-a',
          onSelect: () => {},
          onOpenSettings: () => {},
          aiButton: { active: false, onSelect: () => {} },
        }),
        React.createElement(rail.RailOrderSetting),
      ),
    ),
  );
  const resetButton = () => document.querySelector('.rail-order-reset') ?? undefined;
  assert.ok(resetButton() === undefined, 'no reset button while the order is the default');
  assert.doesNotMatch(document.body.textContent, /Sidebar icon order/);
  assert.doesNotMatch(document.body.textContent, /Already default/);
  await down('pages', 62);
  await move('pages', 20, 136);
  await up('pages', 20, 136);
  assert.match(document.body.textContent, /Sidebar icon order/, 'the row appears right after a drag, with the dialog open');
  assert.match(document.body.textContent, /Drag icons in the sidebar to reorder them/);
  assert.equal(resetButton().textContent, 'Reset to default');
  await act(async () => resetButton().click());
  assert.deepEqual(ids('top'), DEFAULT_TOP, 'the rail is in the default order at once');
  assert.deepEqual(ids('bottom'), DEFAULT_BOTTOM);
  assert.ok(stored() === null, 'the stored order is forgotten');
  assert.ok(resetButton() === undefined, 'the row is gone after the reset');
  assert.equal(document.querySelector('.rail-order-live').textContent, 'Sidebar order reset');
  assert.deepEqual(apiCalls, [], 'nothing went through the app bridge, so nothing was written to a project');
  await unmount();
});

// ---------------------------------------------------------------------------
// The Settings panel's root as a third container
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = ['secrets', 'mcp', 'instructions', 'agents'];
let shownViews = [];
let openedPanels = [];
async function mountWithSettings(options = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        undefined,
        React.createElement(rail.LeftRail, {
          projectPath: '/project-a',
          active: options.active,
          onSelect: (tab) => selected.push(tab),
          onOpenSettings: (target) => selected.push(`settings:${target}`),
          componentOpen: false,
          aiButton: { active: false, onSelect: () => selected.push('ai') },
        }),
        React.createElement(rail.SettingsRailRows, {
          show: (view) => shownViews.push(view),
          onOpenPanel: (panel) => openedPanels.push(panel),
          componentOpen: false,
        }),
      ),
    ),
  );
}
const rows = () => [...document.querySelectorAll('[data-rail-group="settings"]')].map((row) => row.dataset.railId);
const row = (id) => document.querySelector(`[data-rail-group="settings"][data-rail-id="${id}"]`);
const rowPointer = (id, type, x, y) => pointer(row(id), type, x, y);
// Every id lives in exactly one place: the invariant every move keeps.
function assertWhole() {
  const order = JSON.parse(stored());
  const all = [...order.top, ...order.bottom, ...order.settings];
  assert.equal(new Set(all).size, all.length, 'no id repeats');
  for (const id of [...DEFAULT_TOP, ...DEFAULT_BOTTOM, ...DEFAULT_SETTINGS, 'properties']) {
    assert.ok(all.includes(id), `${id} is somewhere`);
  }
}
// The Settings button sits third in the bottom list: 722 to 754, its middle at 738.
const SETTINGS_MIDDLE_Y = 738;

test('Settings rows draw in the default order and open their view', async () => {
  shownViews = [];
  await mountWithSettings();
  assert.deepEqual(rows(), DEFAULT_SETTINGS);
  await act(async () => row('mcp').click());
  assert.deepEqual(shownViews, ['mcp']);
  await unmount();
});

test('dragging a Settings row up or down reorders the rows, with a line at the slot', async () => {
  await mountWithSettings();
  await rowPointer('agents', 'pointerdown', 100, 225);
  await rowPointer('agents', 'pointermove', 100, 215);
  await rowPointer('agents', 'pointermove', 100, 120);
  assert.equal(row('secrets').dataset.dropLine, 'before', 'the line shows before the first row');
  assert.equal(row('agents').dataset.dragging, 'true');
  assert.ok(document.querySelector('.rail-ghost'), 'the row has a ghost');
  await rowPointer('agents', 'pointerup', 100, 120);
  assert.deepEqual(rows(), ['agents', 'secrets', 'mcp', 'instructions']);
  assert.ok(document.querySelector('.rail-ghost') === null);
  assertWhole();
  await unmount();
});

test('a rail button dropped on the middle of the Settings button becomes the last Settings row and leaves the rail', async () => {
  openedPanels = [];
  await mountWithSettings();
  const y = ids('top').indexOf('history') * 36 + 26;
  await down('history', y);
  await move('history', 20, y + 20);
  await move('history', 20, SETTINGS_MIDDLE_Y);
  assert.equal(button('projectSettings').dataset.dropTarget, 'true', 'the Settings button is lit as the target');
  assert.ok(document.querySelector('.rail-drop-line') === null, 'no rail line while the drop goes inside Settings');
  await up('history', 20, SETTINGS_MIDDLE_Y);
  assert.ok(!ids('top').includes('history'), 'it left the rail');
  assert.deepEqual(rows(), [...DEFAULT_SETTINGS, 'history']);
  await act(async () => row('history').click());
  assert.deepEqual(openedPanels, ['history'], 'its row opens its panel in the panel area');
  assertWhole();
  await unmount();
});

test('a rail button dropped between Settings rows lands there; resting on Settings first opens it', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await mountWithSettings();
  await down('assets', 3 * 36 + 26);
  await move('assets', 20, 3 * 36 + 46);
  await move('assets', 20, SETTINGS_MIDDLE_Y);
  await act(async () => context.mock.timers.tick(500));
  assert.equal(selected.at(-1), 'projectSettings', 'resting on Settings opens the Settings panel');
  await move('assets', 120, 150);
  assert.equal(row('mcp').dataset.dropLine, 'before');
  await up('assets', 120, 150);
  assert.deepEqual(rows(), ['secrets', 'assets', 'mcp', 'instructions', 'agents']);
  assertWhole();
  await act(async () => context.mock.timers.tick(10));
  context.mock.timers.reset();
  await unmount();
});

test('Settings and the AI button never go inside Settings', async () => {
  await mountWithSettings();
  await down('ai', 784);
  await move('ai', 20, 770);
  await move('ai', 20, SETTINGS_MIDDLE_Y);
  assert.ok(button('projectSettings').dataset.dropTarget === undefined, 'Settings is no target for the AI button');
  await move('ai', 120, 150);
  await up('ai', 120, 150);
  assert.ok(!rows().includes('ai'));
  assert.ok(button('ai'), 'the AI button is still on the rail');
  await unmount();
});

test('a Settings row dragged out onto the rail becomes a button there that opens Settings at its view', async () => {
  await mountWithSettings();
  await rowPointer('secrets', 'pointerdown', 100, 125);
  await rowPointer('secrets', 'pointermove', 100, 140);
  await rowPointer('secrets', 'pointermove', 20, 50);
  assert.equal(document.querySelector('.rail').dataset.dropReady, 'true', 'the rail is lit as the place to drop');
  assert.ok(document.querySelector('.rail-drop-line'), 'the rail draws its line for a row dragged from Settings');
  await rowPointer('secrets', 'pointerup', 20, 50);
  assert.deepEqual(rows(), ['mcp', 'instructions', 'agents']);
  assert.equal(ids('top')[1], 'secrets', 'it is a rail button, before Pages');
  assert.match(button('secrets').getAttribute('aria-label'), /Secrets/);
  await act(async () => button('secrets').click());
  assert.equal(selected.at(-1), 'settings:secrets', 'the button opens Settings at its view');
  assertWhole();
  await unmount();
});

test('the keyboard moves Settings rows: Alt+arrows reorder, Alt+Left moves out', async () => {
  await mountWithSettings();
  row('secrets').focus();
  await press(row('secrets'), 'ArrowDown', { altKey: true });
  assert.deepEqual(rows(), ['mcp', 'secrets', 'instructions', 'agents']);
  assert.equal(document.activeElement, row('secrets'), 'focus stays on the moved row');
  assert.match(document.querySelector('.settings-rail-list .rail-live').textContent, /^Secrets: Settings, position 2 of 4$/);
  await press(row('secrets'), 'ArrowUp', { altKey: true });
  assert.deepEqual(rows(), DEFAULT_SETTINGS);
  await press(row('mcp'), 'ArrowLeft', { altKey: true });
  assert.deepEqual(rows(), ['secrets', 'instructions', 'agents']);
  assert.deepEqual(ids('bottom'), ['selectors', 'audits', 'mcp', 'projectSettings', 'ai'], 'out onto the rail, right above Settings');
  assert.equal(document.activeElement, button('mcp'), 'focus follows it onto the rail');
  await act(async () => row('instructions').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.deepEqual(
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ['Move up', 'Move down', 'Move to sidebar'],
  );
  assertWhole();
  await unmount();
});

test('a role hides an item wherever it lives, and the empty Settings list is still a drop target', async () => {
  // Every view out on the rail, then a role without project Settings: its views vanish from the rail too.
  const order = { version: 2, top: [...DEFAULT_TOP, 'secrets', 'mcp', 'instructions', 'agents'], bottom: DEFAULT_BOTTOM, settings: [] };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  await mountWithSettings();
  assert.deepEqual(rows(), []);
  assert.match(document.querySelector('.settings-rail-empty').textContent, /Drag sidebar icons here/);
  await down('pages', 62);
  await move('pages', 20, 80);
  await move('pages', 150, 300);
  await up('pages', 150, 300);
  assert.deepEqual(rows(), ['pages']);
  await unmount();
  rail.setActualRole(rail.roleViewOf(rail.DEFAULT_PROJECT_ROLES, 'client'));
  await mountWithSettings();
  for (const id of ['secrets', 'mcp']) {
    assert.ok(button(id) === null, `${id} is hidden from a role without project Settings`);
  }
  const kept = JSON.parse(stored());
  assert.ok(kept.top.includes('secrets'), 'the hidden view keeps its place');
  await unmount();
});

// The rows' places, top to bottom (the mock layout): Secrets 110 to 140, MCP 146 to 176, Instructions 182 to 212,
// Agents 218 to 248; the list box runs 100 to 400, so 100 to 110 is the band above the first row.
async function dragRailIconTo(id, x, y) {
  const startY = ids('top').indexOf(id) * 36 + 26;
  await down(id, startY);
  await move(id, 20, startY + 20);
  await move(id, x, y);
}

test('a rail icon dropped in the band above the first Settings row lands first, with the line at the top', async () => {
  await mountWithSettings();
  await dragRailIconTo('history', 120, 103);
  assert.equal(row('secrets').dataset.dropLine, 'before', 'the line sits at the top of the first row');
  await up('history', 120, 103);
  assert.deepEqual(rows(), ['history', ...DEFAULT_SETTINGS]);
  assertWhole();
  await unmount();
});

test('a rail icon dropped on the top half of the first row lands first too; a Settings row can be moved above it', async () => {
  await mountWithSettings();
  await dragRailIconTo('code', 120, 115);
  await up('code', 120, 115);
  assert.deepEqual(rows(), ['code', ...DEFAULT_SETTINGS]);
  await rowPointer('agents', 'pointerdown', 100, 260);
  await rowPointer('agents', 'pointermove', 100, 240);
  await rowPointer('agents', 'pointermove', 100, 101);
  assert.equal(row('code').dataset.dropLine, 'before');
  await rowPointer('agents', 'pointerup', 100, 101);
  assert.deepEqual(rows(), ['agents', 'code', 'secrets', 'mcp', 'instructions']);
  assertWhole();
  await unmount();
});

test('a rail icon dropped between two Settings rows lands between them', async () => {
  await mountWithSettings();
  await dragRailIconTo('cms', 120, 225);
  assert.equal(row('agents').dataset.dropLine, 'before');
  await up('cms', 120, 225);
  assert.deepEqual(rows(), ['secrets', 'mcp', 'instructions', 'cms', 'agents']);
  assertWhole();
  await unmount();
});

test('a rail icon dropped in the empty area under the last row is appended, with the line under the last row', async () => {
  await mountWithSettings();
  await dragRailIconTo('variables', 120, 380);
  assert.equal(row('agents').dataset.dropLine, 'after');
  await up('variables', 120, 380);
  assert.deepEqual(rows(), [...DEFAULT_SETTINGS, 'variables']);
  assertWhole();
  await unmount();
});

test('after resting on Settings opens it, a rail icon dropped above the first row lands first', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await mountWithSettings();
  await dragRailIconTo('components', 20, SETTINGS_MIDDLE_Y);
  await act(async () => context.mock.timers.tick(500));
  assert.equal(selected.at(-1), 'projectSettings');
  await move('components', 120, 104);
  await up('components', 120, 104);
  assert.deepEqual(rows(), ['components', ...DEFAULT_SETTINGS]);
  await act(async () => context.mock.timers.tick(10));
  context.mock.timers.reset();
  await unmount();
});

test('the keyboard and the menu move a row to the first place', async () => {
  await mountWithSettings();
  await act(async () => row('mcp').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const up = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Move up');
  await act(async () => up.click());
  assert.deepEqual(rows(), ['mcp', 'secrets', 'instructions', 'agents']);
  await act(async () => row('mcp').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.ok(![...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Move up'), 'the first row offers no Move up');
  await press(row('secrets'), 'ArrowUp', { altKey: true });
  assert.deepEqual(rows(), DEFAULT_SETTINGS);
  await unmount();
});

test('the empty Settings list shows its hint and lights it as the target', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, top: [...DEFAULT_TOP, ...DEFAULT_SETTINGS], bottom: DEFAULT_BOTTOM, settings: [] }));
  await mountWithSettings();
  const hint = () => document.querySelector('.settings-rail-empty');
  assert.equal(hint().textContent, 'Drag sidebar icons here to keep them in Settings');
  assert.ok(hint().dataset.dropReady === undefined, 'not lit at rest');
  await dragRailIconTo('assets', 120, 104);
  assert.equal(hint().dataset.dropReady, 'true', 'lit while a drop would land there');
  await up('assets', 120, 104);
  assert.deepEqual(rows(), ['assets']);
  assert.ok(hint() === null);
  await unmount();
});

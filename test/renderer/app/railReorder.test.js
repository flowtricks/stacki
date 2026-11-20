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
window.HTMLElement.prototype.getBoundingClientRect = function () {
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
const DEFAULT_TOP = ['pages', 'navigator', 'assets', 'cms', 'variables', 'history', 'components', 'apps', 'code'];
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

test('the default order: Pages to Code on top, then Style selectors, Audits, Settings and AI at the foot', async () => {
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
  await down('pages', 26);
  await move('pages', 20, 40);
  await move('pages', 20, 100);
  assert.ok(document.querySelector('.rail-ghost'), 'a ghost follows the pointer');
  assert.ok(document.querySelector('.rail-drop-line'), 'a line shows the slot');
  assert.equal(button('pages').dataset.dragging, 'true', 'the dragged button keeps its place, dimmed');
  assert.deepEqual(ids('top'), DEFAULT_TOP, 'nothing moves until the drop');
  // The product clears its swallow-the-click flag with a zero-delay timer; the mocked clock runs it on demand instead of a guessed pause.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await upAndClick('pages', 20, 100);
  assert.deepEqual(ids('top').slice(0, 3), ['navigator', 'assets', 'pages']);
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
  await down('pages', 26);
  await move('pages', 20, 40);
  await move('pages', 20, 780);
  assert.ok(document.querySelector('.rail-slot-empty'), 'a placeholder stands in for the empty list while dragging');
  await up('pages', 20, 780);
  assert.deepEqual(ids('bottom'), ['pages']);
  assert.ok(document.querySelector('.rail-slot-empty') === null);
  await unmount();
});

test('Escape cancels, and so does a release outside the rail', async () => {
  await mount();
  await down('pages', 26);
  await move('pages', 20, 100);
  await press(window, 'Escape');
  assert.ok(document.querySelector('.rail-ghost') === null, 'Escape ends the drag');
  await up('pages', 20, 100);
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  await down('pages', 26);
  await move('pages', 20, 100);
  await move('pages', 300, 100);
  assert.equal(document.querySelector('.rail-ghost').dataset.outside, 'true');
  assert.ok(document.querySelector('.rail-drop-line') === null, 'no slot outside the rail');
  await up('pages', 300, 100);
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.ok(stored() === null);
  await unmount();
});

test('the tooltip is hidden while dragging', async () => {
  await mount();
  await act(async () => button('pages').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  await down('pages', 26);
  await move('pages', 20, 100);
  assert.ok(document.querySelector('.rail-tooltip') === null);
  await press(window, 'Escape');
  await unmount();
});

test('Alt+arrows reorder a focused button, move it between lists, and announce the new place', async () => {
  await mount();
  button('pages').focus();
  await press(button('pages'), 'ArrowDown', { altKey: true });
  assert.deepEqual(ids('top').slice(0, 2), ['navigator', 'pages']);
  assert.equal(document.activeElement, button('pages'), 'focus stays on the moved button');
  assert.match(document.querySelector('.rail-live').textContent, /^Pages: top group, position 2 of 9$/);
  await press(button('pages'), 'ArrowUp', { altKey: true });
  assert.deepEqual(ids('top').slice(0, 2), ['pages', 'navigator']);
  await press(button('pages'), 'ArrowRight', { altKey: true });
  assert.deepEqual(ids('bottom'), ['pages', ...DEFAULT_BOTTOM]);
  assert.equal(document.activeElement, button('pages'), 'focus survives the move into the other list');
  assert.match(document.querySelector('.rail-live').textContent, /bottom group, position 1 of 5/);
  await press(button('pages'), 'ArrowLeft', { altKey: true });
  assert.equal(ids('top').at(-1), 'pages');
  const before = stored();
  await press(button('navigator'), 'ArrowUp', { altKey: true });
  assert.equal(stored(), before, 'a move that changes nothing stores nothing');
  await press(button('navigator'), 'ArrowDown');
  assert.equal(stored(), before, 'arrows without Alt do not move');
  await unmount();
});

test('the order is read before the first frame, survives a remount and a project switch', async () => {
  await mount({ projectPath: '/project-a' });
  await down('pages', 26);
  await move('pages', 20, 100);
  await up('pages', 20, 100);
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
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'p', bubbles: true })));
  assert.deepEqual(selected.at(-1), 'pages', 'the P shortcut selects Pages wherever it sits');
  await unmount();
});

test('right-clicking offers Move to bottom group and Reset rail order', async () => {
  await mount();
  await act(async () => button('code').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const rows = [...document.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['Move to bottom group', 'Reset rail order'],
  );
  assert.ok(rows[1].disabled || rows[1].getAttribute('aria-disabled') === 'true', 'reset has nothing to do in the default order');
  await act(async () => rows[0].click());
  assert.ok(ids('bottom').includes('code'));
  await act(async () => button('pages').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const reset = [...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent === 'Reset rail order');
  await act(async () => reset.click());
  assert.deepEqual(ids('top'), DEFAULT_TOP);
  assert.deepEqual(ids('bottom'), DEFAULT_BOTTOM);
  assert.ok(stored() === null, 'reset forgets the stored order');
  await unmount();
});

test('nothing is written to a project: no file API call, and the only storage written is the rail order key', async () => {
  await mount();
  await down('pages', 26);
  await move('pages', 20, 100);
  await up('pages', 20, 100);
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

test('Settings shows the Sidebar icon order row: disabled at the default, live after a drag, and a press resets the rail at once', async () => {
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
  const resetButton = () => document.querySelector('.rail-order-reset');
  assert.match(document.body.textContent, /Sidebar icon order/);
  assert.match(document.body.textContent, /Drag icons in the sidebar to reorder them/);
  assert.equal(resetButton().disabled, true);
  assert.equal(resetButton().textContent, 'Already default');
  await down('pages', 26);
  await move('pages', 20, 100);
  await up('pages', 20, 100);
  assert.equal(resetButton().disabled, false, 'the button enables right after a drag, with the dialog open');
  assert.equal(resetButton().textContent, 'Reset to default');
  await act(async () => resetButton().click());
  assert.deepEqual(ids('top'), DEFAULT_TOP, 'the rail is in the default order at once');
  assert.deepEqual(ids('bottom'), DEFAULT_BOTTOM);
  assert.ok(stored() === null, 'the stored order is forgotten');
  assert.equal(resetButton().disabled, true);
  assert.equal(document.querySelector('.rail-order-live').textContent, 'Sidebar order reset');
  assert.deepEqual(apiCalls, [], 'nothing went through the app bridge, so nothing was written to a project');
  await unmount();
});

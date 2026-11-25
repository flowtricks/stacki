// Goal: while a tile is dragged from the Add elements panel the Navigator is drawn over the panel, for a role
// that has the Navigator, and it goes away when the drag ends however it ends, leaving the panel as it was. And the
// panel is a rail tab of its own: its button opens on ⌥E, sits first in the default order, and a session reopens it.
// Methodology: walk the pure state machine through every transition (start, a repeated start, end, end while idle)
// for both roles; then read the rail's shortcut table, its default order and the seeded tab, which are pure too.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const machine = loadRenderer('src/app/state/elementDragNavigator.ts');
const shortcuts = loadRenderer('src/app/railShortcuts.ts');
const { DEFAULT_RAIL_ORDER } = loadRenderer('src/app/railDefaults.ts');
const { resolveRailOrder } = loadRenderer('src/app/railOrder.ts');
const { seededLeftTabOf } = loadRenderer('src/app/model/seededLeftTab.ts');

const { ELEMENT_DRAG_IDLE, nextElementDragState, navigatorShown } = machine;

test('a drag shows the Navigator over the panel and its end takes it away', () => {
  assert.equal(navigatorShown(ELEMENT_DRAG_IDLE), false, 'nothing is shown before a drag');
  const dragging = nextElementDragState(ELEMENT_DRAG_IDLE, { kind: 'start', navigator: 'allowed' });
  assert.deepEqual(dragging, { kind: 'dragging', navigator: 'overlay' });
  assert.equal(navigatorShown(dragging), true);
  assert.equal(nextElementDragState(dragging, { kind: 'start', navigator: 'allowed' }), dragging, 'a repeated start changes nothing');
  assert.equal(nextElementDragState(dragging, { kind: 'end' }), ELEMENT_DRAG_IDLE, 'the end restores the panel');
  assert.equal(nextElementDragState(ELEMENT_DRAG_IDLE, { kind: 'end' }), ELEMENT_DRAG_IDLE, 'a stray end is harmless');
});

test('a role without the Navigator drags without it', () => {
  const dragging = nextElementDragState(ELEMENT_DRAG_IDLE, { kind: 'start', navigator: 'denied' });
  assert.deepEqual(dragging, { kind: 'dragging', navigator: 'none' });
  assert.equal(navigatorShown(dragging), false);
  assert.equal(nextElementDragState(dragging, { kind: 'end' }), ELEMENT_DRAG_IDLE);
});

test('Add elements opens on ⌥E, first in the rail, and a session reopens it', () => {
  const press = (key, init = {}) =>
    shortcuts.railActionOf({ altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, key, code: `Key${key.toUpperCase()}`, ...init });
  assert.equal(press('e', { altKey: true })?.action, 'elements');
  assert.equal(press('a')?.action, undefined, 'the plain letter it had opens nothing');
  assert.equal(press('e', { metaKey: true }), undefined, '⌘E is the insert palette');
  assert.equal(shortcuts.shortcutOf('elements'), '⌥E');
  assert.equal(DEFAULT_RAIL_ORDER.top[0], 'elements', 'at the top of the rail, as in Webflow');
  // A person who arranged the rail before the panel existed gets it at its default place, without losing their order.
  const stored = { top: ['navigator', 'pages'], bottom: ['ai'], settings: [] };
  const resolved = resolveRailOrder(DEFAULT_RAIL_ORDER, stored);
  assert.equal(resolved.top[0], 'elements');
  assert.ok(resolved.top.indexOf('navigator') < resolved.top.indexOf('pages'), 'the stored order of the rest holds');
  assert.deepEqual(seededLeftTabOf('elements'), { tab: 'elements', showInstructions: false });
});

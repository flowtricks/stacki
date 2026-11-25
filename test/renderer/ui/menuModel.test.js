// Goal: the shared Menu's keyboard model and placement are right before any pixel is drawn:
// which row an arrow, a digit or a letter lands on, that disabled rows and dividers are
// skipped, and that a menu opened near any window edge stays inside the window.
// Method: the pure functions of src/ui/menuModel.ts on small row lists, including the
// negative space (an empty menu, every row disabled, a digit nobody owns, modified keys,
// duplicate ids, a menu taller than the window).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { assertMenuEntries, decideKey, initialIndex, placeMenu, stepIndex, indexOfNumberKey, indexOfAccelerator } = load('src/ui/menuModel.ts');

const none = { altKey: false, ctrlKey: false, metaKey: false };
const item = (id, extra = {}) => ({ kind: 'item', id, label: id, onSelect() {}, ...extra });
const entries = [
  { kind: 'heading', id: 'h', label: 'Mode' },
  item('a', { numberKey: 1, accelerator: 'a' }),
  item('b', { numberKey: 2, disabled: true }),
  { kind: 'divider', id: 'd' },
  item('c', { numberKey: 3, checked: true }),
  { kind: 'submenu', id: 's', label: 'More', entries: [item('x')] },
  { kind: 'toggle', id: 't', label: 'Fast', on: false, onChange() {} },
  { kind: 'note', id: 'n', text: 'note' },
];

test('arrows skip headings, dividers, notes and disabled rows, and wrap', () => {
  assert.equal(stepIndex(entries, undefined, 1), 1);
  assert.equal(stepIndex(entries, 1, 1), 4);
  assert.equal(stepIndex(entries, 4, 1), 5);
  assert.equal(stepIndex(entries, 6, 1), 1);
  assert.equal(stepIndex(entries, 1, -1), 6);
  assert.equal(stepIndex(entries, undefined, -1), 6);
});

test('a menu with no navigable row has nowhere to step', () => {
  assert.equal(stepIndex([], undefined, 1), undefined);
  assert.equal(stepIndex([item('a', { disabled: true }), { kind: 'divider', id: 'd' }], undefined, 1), undefined);
  assert.equal(initialIndex([item('a', { disabled: true })]), undefined);
});

test('the checked row is where focus starts, else the first enabled row', () => {
  assert.equal(initialIndex(entries), 4);
  assert.equal(initialIndex(entries.filter((entry) => entry.id !== 'c')), 1);
});

test('digits choose the row with that numberKey; a disabled or unowned digit does nothing', () => {
  assert.deepEqual(decideKey(entries, undefined, '1', none), { kind: 'choose', index: 1 });
  assert.deepEqual(decideKey(entries, 1, '3', none), { kind: 'choose', index: 4 });
  assert.deepEqual(decideKey(entries, 1, '2', none), { kind: 'ignore' }, 'row 2 is disabled');
  assert.deepEqual(decideKey(entries, 1, '9', none), { kind: 'ignore' });
  assert.equal(indexOfNumberKey(entries, 2), undefined);
});

test('letters choose by accelerator, ignoring case', () => {
  assert.deepEqual(decideKey(entries, undefined, 'A', none), { kind: 'choose', index: 1 });
  assert.equal(indexOfAccelerator(entries, 'z'), undefined);
});

test('Right opens a submenu only from a submenu row; Left always asks to close one', () => {
  assert.deepEqual(decideKey(entries, 5, 'ArrowRight', none), { kind: 'open-submenu', index: 5 });
  assert.deepEqual(decideKey(entries, 1, 'ArrowRight', none), { kind: 'ignore' });
  assert.deepEqual(decideKey(entries, 5, 'ArrowLeft', none), { kind: 'close-submenu' });
});

test('Enter and Space choose the focused row, and open a submenu row instead', () => {
  assert.deepEqual(decideKey(entries, 1, 'Enter', none), { kind: 'choose', index: 1 });
  assert.deepEqual(decideKey(entries, 6, ' ', none), { kind: 'choose', index: 6 });
  assert.deepEqual(decideKey(entries, 5, 'Enter', none), { kind: 'open-submenu', index: 5 });
  assert.deepEqual(decideKey(entries, undefined, 'Enter', none), { kind: 'ignore' });
  assert.deepEqual(decideKey(entries, 2, 'Enter', none), { kind: 'ignore' }, 'a disabled row');
});

test('Home and End jump; Tab closes; keys with a modifier are left to the app', () => {
  assert.deepEqual(decideKey(entries, 4, 'Home', none), { kind: 'focus', index: 1 });
  assert.deepEqual(decideKey(entries, 4, 'End', none), { kind: 'focus', index: 6 });
  assert.deepEqual(decideKey(entries, 4, 'Tab', none), { kind: 'close' });
  assert.deepEqual(decideKey(entries, 4, '1', { ...none, metaKey: true }), { kind: 'ignore' });
  assert.deepEqual(decideKey(entries, 4, 'ArrowDown', { ...none, altKey: true }), { kind: 'ignore' });
  assert.deepEqual(decideKey(entries, 4, 'Shift', none), { kind: 'ignore' });
});

test('invalid menus fail loudly', () => {
  assert.throws(() => assertMenuEntries([item('a'), item('a')]), /duplicate entry id a/);
  assert.throws(() => assertMenuEntries([item('a', { numberKey: 0 })]), /numberKey is 1 to 9/);
  assert.throws(() => assertMenuEntries([item('a', { numberKey: 10 })]), /numberKey is 1 to 9/);
  assert.throws(() => assertMenuEntries([item('a', { accelerator: 'ab' })]), /accelerator is one character/);
  assert.throws(() => assertMenuEntries([item('')]), /every entry has an id/);
  assert.throws(() => stepIndex(entries, 99, 1), /from is inside the entries/);
});

const viewport = { width: 800, height: 600 };
const inside = (position, size) => {
  assert.ok(position.left >= 8, 'left edge');
  assert.ok(position.top >= 8, 'top edge');
  assert.ok(position.left + size.width <= viewport.width - 8, 'right edge');
  assert.ok(position.top + Math.min(size.height, position.heightMax ?? size.height) <= viewport.height - 8, 'bottom edge');
};

test('a menu stays inside the window from every placement and anchor', () => {
  const size = { width: 260, height: 300 };
  for (const placement of ['below-start', 'below-end', 'above-start', 'above-end', 'right-start']) {
    for (const x of [0, 400, 790]) {
      for (const y of [0, 300, 590]) {
        const anchor = { left: x, top: y, width: 80, height: 28 };
        inside(placeMenu(anchor, size, viewport, placement), size);
      }
    }
  }
});

test('a menu opens above when below has no room, and below when above has none', () => {
  const size = { width: 200, height: 250 };
  const low = placeMenu({ left: 100, top: 560, width: 40, height: 24 }, size, viewport, 'below-start');
  assert.ok(low.top + size.height <= 560, 'sits above the anchor');
  const high = placeMenu({ left: 100, top: 10, width: 40, height: 24 }, size, viewport, 'above-start');
  assert.ok(high.top >= 10 + 24, 'sits below the anchor');
});

test('a submenu flips to the left near the right edge and overlaps its parent slightly', () => {
  const size = { width: 240, height: 200 };
  const roomy = placeMenu({ left: 100, top: 100, width: 220, height: 32 }, size, viewport, 'right-start');
  assert.ok(roomy.left < 100 + 220, 'overlaps the parent by a few pixels');
  assert.ok(roomy.left > 100 + 220 - 10);
  const cramped = placeMenu({ left: 560, top: 100, width: 220, height: 32 }, size, viewport, 'right-start');
  assert.ok(cramped.left + size.width <= 560 + 10, 'opens to the left');
});

test('a menu taller than the window is capped and starts at the top edge', () => {
  const position = placeMenu({ left: 100, top: 300, width: 40, height: 24 }, { width: 200, height: 900 }, viewport, 'below-start');
  assert.equal(position.heightMax, 584);
  assert.equal(position.top, 8);
});

test('placement refuses an empty menu or window', () => {
  const anchor = { left: 0, top: 0, width: 10, height: 10 };
  assert.throws(() => placeMenu(anchor, { width: 0, height: 10 }, viewport, 'below-start'), /the menu has width/);
  assert.throws(() => placeMenu(anchor, { width: 10, height: 10 }, { width: 0, height: 1 }, 'below-start'), /the window has width/);
});

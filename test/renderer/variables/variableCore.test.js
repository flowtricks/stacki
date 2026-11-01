// Pure row planning preserves column holes and heading boundaries. A browser-like
// clamping peer checks scroll echoes, cleanup, and registration/collection limits.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const rows = load('src/features/variables/variableRows.ts');
const { createScrollSync, createScrollLanes, SCROLL_PEERS_MAX } = load('src/features/variables/variableScroll.ts');
const cell = (name) => ({
  name,
  file: 'tokens.css',
  selector: ':root',
  column: '0',
  value: 'red',
  valueStart: 10,
  valueEnd: 13,
  line: 1,
});
const first = {
  label: 'primary',
  name: '--color-primary',
  cells: [cell('--color-primary'), undefined],
};
const second = {
  label: 'secondary',
  name: '--color-secondary',
  cells: [cell('--color-secondary')],
};
const block = { kind: 'rows', title: 'color', rows: [first, second] };
const empty = { kind: 'rows', title: 'Other', titleStart: 90, rows: [] };
const { slots, offsets } = rows.buildSheetSlots([block, empty]);
assert.deepEqual(offsets, [
  { head: 0, rows: 1 },
  { head: 4, rows: 5 },
]);
assert.equal(rows.stemOf(block), '--color-');
assert.equal(rows.sectionPrefix(block), 'color');
assert.deepEqual(rows.rowRenames(block, first, 'accent'), [{ from: '--color-primary', to: '--color-accent' }]);
assert.deepEqual(rows.movesForDrop(slots, 1, 3), [{ file: 'tokens.css', selector: ':root', name: '--color-primary', at: 90 }]);
assert.equal(rows.dropPlan(slots, 0, 1), undefined);
assert.equal(rows.dropPlan(slots, 99, 0), undefined);
assert.equal(rows.dropPlan(slots, 0, 2).before, '--color-secondary');
const matrix = { kind: 'matrix', title: 'Heading', rows: [] };
assert.equal(rows.sectionPrefix(matrix), undefined);
assert.deepEqual(rows.rowRenames(matrix, { label: 'size', cells: [cell('--h1-size'), undefined, cell('--h3-size')] }, 'weight'), [
  { from: '--h1-size', to: '--h1-weight' },
  { from: '--h3-size', to: '--h3-weight' },
]);
for (const invalid of [-1, 0.5, NaN, Infinity]) {
  assert.throws(() => rows.movesForDrop(slots, invalid, 0), /source index/);
  assert.throws(() => rows.dropPlan(slots, 0, invalid), /target index/);
}
assert.throws(() => rows.buildSheetSlots(Array(10001).fill(empty)), /block limit exceeded/);
assert.throws(() => rows.buildSheetSlots([{ ...block, rows: Array(10000).fill(first) }]), /slot limit exceeded/);
assert.throws(() => rows.rowRenames(block, first, 'x'.repeat(8193)), /name limit exceeded/);
assert.throws(() => rows.stemOf({ ...block, rows: [{ name: '--x', label: 'too long' }] }), /label exceeds name/);
const sync = createScrollSync();
const firstPeer = { scrollLeft: 0 };
const secondPeer = { scrollLeft: 0 };
let clampedPosition = 0;
const narrowPeer = {
  get scrollLeft() {
    return clampedPosition;
  },
  set scrollLeft(value) {
    clampedPosition = Math.min(40, value);
  },
};
const unregister = sync.register(secondPeer);
sync.register(firstPeer);
sync.register(narrowPeer);
firstPeer.scrollLeft = 80;
sync.broadcast(firstPeer, 80);
assert.equal(secondPeer.scrollLeft, 80);
assert.equal(narrowPeer.scrollLeft, 40, 'narrower tables clamp at their own end');
sync.broadcast(narrowPeer, 40);
assert.equal(firstPeer.scrollLeft, 80, 'delayed clamped echoes preserve the common position');
secondPeer.scrollLeft = 30;
sync.broadcast(secondPeer, 30);
assert.equal(firstPeer.scrollLeft, 30, 'a real gesture immediately takes control');
unregister();
firstPeer.scrollLeft = 100;
sync.broadcast(firstPeer, 100);
assert.equal(secondPeer.scrollLeft, 30, 'unregistered peers stay untouched');
sync.fit(20);
assert.equal(firstPeer.scrollLeft, 20, 'resizing clamps the common position');
assert.equal(narrowPeer.scrollLeft, 20);
sync.fit(0);
assert.equal(firstPeer.scrollLeft, 0, 'removing overflow resets the position');
sync.dispose();
const oldCleanup = sync.register(secondPeer);
sync.dispose();
sync.register(secondPeer);
oldCleanup();
sync.broadcast(firstPeer, 50);
assert.equal(secondPeer.scrollLeft, 50, 'old cleanup cannot remove a new registration');
const latePeer = { scrollLeft: 0 };
sync.register(latePeer);
assert.equal(latePeer.scrollLeft, 50, 'new sections inherit the current position');
sync.dispose();
assert.throws(() => sync.fit(-1), /nonnegative/);
assert.throws(() => sync.fit(Infinity), /finite/);
assert.throws(() => sync.broadcast(firstPeer, NaN), /finite/);
for (let index = 0; index < SCROLL_PEERS_MAX; index++) {
  sync.register({ scrollLeft: 0 });
}
assert.throws(() => sync.register({ scrollLeft: 0 }), /peer limit exceeded/);
sync.dispose();
// Lanes: tables with the same column count scroll together, others do not.
const lanes = createScrollLanes();
assert.equal(lanes.lane(3), lanes.lane(3), 'one lane per column count');
const sheetPeer = { scrollLeft: 0 };
const sameColumnsPeer = { scrollLeft: 0 };
const matrixPeer = { scrollLeft: 0 };
lanes.lane(3).register(sheetPeer);
lanes.lane(3).register(sameColumnsPeer);
lanes.lane(5).register(matrixPeer);
lanes.lane(3).broadcast(sheetPeer, 60);
assert.equal(sameColumnsPeer.scrollLeft, 60);
assert.equal(matrixPeer.scrollLeft, 0, 'a table with other columns keeps its own position');
lanes.lane(5).broadcast(matrixPeer, 25);
assert.equal(sheetPeer.scrollLeft, 60, 'and does not move the sheet');
const kept = lanes.lane(5);
lanes.dispose();
assert.equal(lanes.lane(5), kept, 'dispose resets lanes without replacing them');
assert.throws(() => lanes.lane(-1), /nonnegative/);
assert.throws(() => lanes.lane(1.5), /integer/);
console.log('variable-core: moves, rename rules, bounds, scroll echoes, lanes and cleanup passed');

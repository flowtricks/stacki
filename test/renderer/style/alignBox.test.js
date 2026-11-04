// Goal: the alignment box does what its dots and arrows show. With Space
// between, a dot in the vertical middle sets only vertical center (the items
// stay spread); the arrow keys step the vertical alignment through top,
// center and bottom (Up/Down) and the horizontal one (Left/Right).
// Method: the box's pure rules, in a row and in a column, at each edge.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { alignDotWrites, alignArrowWrite } = load('src/features/style/AlignControl.tsx');

const row = { justify: 'space-between', align: 'stretch', column: false };
assert.deepEqual(alignDotWrites(row, 'center', 'center'), [['align-items', 'center']], 'the spread stays: only the vertical axis is set');
assert.deepEqual(alignDotWrites({ ...row, justify: 'space-around' }, 'flex-end', 'flex-start'), [['align-items', 'flex-start']]);
assert.deepEqual(alignDotWrites({ ...row, justify: 'flex-start' }, 'center', 'flex-end'), [
  ['justify-content', 'center'],
  ['align-items', 'flex-end'],
]);
// A column's main axis is vertical: there the spread is kept on Y.
const column = { justify: 'space-between', align: 'flex-start', column: true };
assert.deepEqual(alignDotWrites(column, 'flex-end', 'center'), [['align-items', 'flex-end']]);

// Arrows: from stretch, a first step goes to center; then one place at a time, stopping at the ends.
assert.deepEqual(alignArrowWrite(row, 'ArrowDown'), ['align-items', 'center']);
assert.deepEqual(alignArrowWrite({ ...row, align: 'center' }, 'ArrowUp'), ['align-items', 'flex-start']);
assert.deepEqual(alignArrowWrite({ ...row, align: 'center' }, 'ArrowDown'), ['align-items', 'flex-end']);
assert.equal(alignArrowWrite({ ...row, align: 'flex-end' }, 'ArrowDown'), undefined, 'already at the bottom');
assert.deepEqual(alignArrowWrite({ ...row, justify: 'flex-start' }, 'ArrowRight'), ['justify-content', 'center']);
assert.deepEqual(alignArrowWrite(column, 'ArrowDown'), ['justify-content', 'center'], 'in a column, Up/Down move the main axis');
assert.equal(alignArrowWrite(row, 'Enter'), undefined);
assert.equal(alignArrowWrite({ ...row, align: 'start' }, 'ArrowUp'), undefined, 'start is the top, spelled either way');
console.log('align box: ok');

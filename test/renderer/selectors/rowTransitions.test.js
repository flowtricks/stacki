// Goal: a selector row's lock animation is a small, total state machine. A
// click starts `changing` (a row another lock moved starts at `collapsing`); the
// save moves it from `saving` to `showing`; the
// colour's time then ends it steady (the row still belongs in the tab) or
// `collapsing` (it does not), and a collapse ends with the row gone. Every
// event a phase does not expect leaves it as it is, so a second click, a late
// timer or a stray transitionend can never duplicate or lose a row.
// Method: drive the pure model through every phase and event, including the
// negative space (events out of order, rows that cannot lock, a full table),
// and pin the assertion messages.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const {
  stepRow,
  stepTransitions,
  stepTransitionsMany,
  rowPhase,
  heldReasons,
  lockShownClosed,
  NO_ROW_TRANSITIONS,
  ROW_TRANSITIONS_MAX,
  ROW_TRANSITION_TIMINGS,
} = loadRenderer('src/features/selectors/rowTransitions.ts');

const toggle = (from, reason) => ({ kind: 'toggle', from, reason });
const SETTLED = { kind: 'settled' };
const COLLAPSED = { kind: 'collapsed' };
const shown = (belongs) => ({ kind: 'shown', belongs });
const left = (reason) => ({ kind: 'left', reason });

test('a row that leaves the tab changes, then collapses, then is gone', () => {
  let row = stepRow(undefined, toggle('unused', undefined));
  assert.deepEqual(row, { phase: 'changing', step: 'saving', from: 'unused', reason: undefined });
  row = stepRow(row, SETTLED);
  assert.deepEqual(row, { phase: 'changing', step: 'showing', reason: undefined });
  row = stepRow(row, shown(false));
  assert.deepEqual(row, { phase: 'collapsing', reason: undefined });
  assert.equal(stepRow(row, COLLAPSED), undefined);
});

test('a row that still belongs (the All tab) ends steady without collapsing', () => {
  const showing = stepRow(stepRow(undefined, toggle('kept', undefined)), SETTLED);
  assert.equal(stepRow(showing, shown(true)), undefined);
});

test('events a phase does not expect leave it unchanged', () => {
  for (const event of [SETTLED, shown(true), shown(false), COLLAPSED]) {
    assert.equal(stepRow(undefined, event), undefined, `steady ignores ${event.kind}`);
  }
  const saving = stepRow(undefined, toggle('unknown', 'pieces'));
  // A second click, an early colour timer and a stray collapse do nothing while saving.
  assert.equal(stepRow(saving, toggle('unknown', 'pieces')), saving);
  assert.equal(stepRow(saving, shown(false)), saving);
  assert.equal(stepRow(saving, COLLAPSED), saving);
  const showing = stepRow(saving, SETTLED);
  assert.equal(stepRow(showing, SETTLED), showing);
  assert.equal(stepRow(showing, toggle('unknown', 'pieces')), showing);
  assert.equal(stepRow(showing, COLLAPSED), showing);
  const collapsing = stepRow(showing, shown(false));
  assert.deepEqual(collapsing, { phase: 'collapsing', reason: 'pieces' }, 'a collapsing row keeps its reason group');
  for (const event of [toggle('unknown', 'pieces'), SETTLED, shown(true), shown(false)]) {
    assert.equal(stepRow(collapsing, event), collapsing, `collapsing ignores ${event.kind}`);
  }
});

test('a row another lock moved collapses like a clicked one', () => {
  const row = stepRow(undefined, left('pieces'));
  assert.deepEqual(row, { phase: 'collapsing', reason: 'pieces' }, 'no click to answer: its colour has shown, so it closes');
  for (const event of [SETTLED, shown(true), shown(false), left('pieces'), toggle('unknown', 'pieces')]) {
    assert.equal(stepRow(row, event), row, `collapsing ignores ${event.kind}`);
  }
  assert.equal(stepRow(row, COLLAPSED), undefined);
  // A clicked row that the same lock change also moved keeps answering its click.
  const saving = stepRow(undefined, toggle('unused', undefined));
  assert.equal(stepRow(saving, left(undefined)), saving);
  const showing = stepRow(saving, SETTLED);
  assert.equal(stepRow(showing, left(undefined)), showing);
});

test('many rows step together, copying the table once and stopping at the bound', () => {
  const ids = ['a|0|0|0', 'b|0|0|0', 'c|0|0|0'];
  const moved = stepTransitionsMany(NO_ROW_TRANSITIONS, ids, left(undefined));
  assert.deepEqual([...moved.keys()], ids);
  assert.equal(NO_ROW_TRANSITIONS.size, 0, 'the empty table is never mutated');
  assert.equal(stepTransitionsMany(moved, ids, SETTLED), moved, 'nothing stepped returns the same table');
  assert.equal(stepTransitionsMany(moved, [], left(undefined)), moved, 'no rows named returns the same table');
  const gone = stepTransitionsMany(moved, ids.slice(0, 2), COLLAPSED);
  assert.deepEqual([...gone.keys()], ['c|0|0|0']);
  assert.throws(() => stepTransitionsMany(moved, ['a|0|0|0', ''], SETTLED), /stepTransitions: a row is named/);
  const tooMany = Array.from({ length: ROW_TRANSITIONS_MAX + 1 }, (_, index) => `a|0|${index}|0`);
  assert.throws(() => stepTransitionsMany(NO_ROW_TRANSITIONS, tooMany, left(undefined)), /one step names no more rows than can animate/);
  const nearlyFull = stepTransitionsMany(NO_ROW_TRANSITIONS, tooMany.slice(0, ROW_TRANSITIONS_MAX - 1), left(undefined));
  const full = stepTransitionsMany(nearlyFull, ['y|0|0|0', 'z|0|0|0'], left(undefined));
  assert.equal(full.size, ROW_TRANSITIONS_MAX, 'rows past the bound within one step change without animation');
  assert.equal(rowPhase(full, 'y|0|0|0'), 'collapsing');
  assert.equal(rowPhase(full, 'z|0|0|0'), 'steady');
});

test('only a lockable row starts a transition', () => {
  assert.throws(() => stepRow(undefined, toggle('used', undefined)), /rowTransitions: a used row has no lock/);
  assert.throws(() => stepRow(undefined, toggle('untracked', undefined)), /rowTransitions: a row with no names has no lock/);
  assert.throws(() => stepRow(undefined, toggle('checking', undefined)), /rowTransitions: a row still being checked has no lock/);
});

test('the table of rows is updated by construction and stays within its bound', () => {
  const one = stepTransitions(NO_ROW_TRANSITIONS, 'a|0|0|0', toggle('unused', undefined));
  assert.equal(NO_ROW_TRANSITIONS.size, 0, 'the empty table is never mutated');
  assert.equal(rowPhase(one, 'a|0|0|0'), 'changing');
  assert.equal(rowPhase(one, 'b|0|0|0'), 'steady');
  assert.equal(stepTransitions(one, 'a|0|0|0', toggle('unused', undefined)), one, 'an ignored event returns the same table');
  assert.equal(stepTransitions(one, 'b|0|0|0', SETTLED), one, 'an event for a steady row returns the same table');
  const collapsing = stepTransitions(stepTransitions(one, 'a|0|0|0', SETTLED), 'a|0|0|0', shown(false));
  assert.equal(rowPhase(collapsing, 'a|0|0|0'), 'collapsing');
  assert.equal(stepTransitions(collapsing, 'a|0|0|0', COLLAPSED).size, 0);
  assert.throws(() => stepTransitions(one, '', SETTLED), /stepTransitions: a row is named/);

  let full = NO_ROW_TRANSITIONS;
  for (let index = 0; index < ROW_TRANSITIONS_MAX; index += 1) {
    full = stepTransitions(full, `a|0|${index}|0`, toggle('unused', undefined));
  }
  assert.equal(full.size, ROW_TRANSITIONS_MAX);
  assert.equal(stepTransitions(full, 'z|0|0|0', toggle('unused', undefined)), full, 'past the bound a row changes without animation');
  assert.equal(rowPhase(stepTransitions(full, 'a|0|0|0', SETTLED), 'a|0|0|0'), 'changing', 'rows already held still step when full');
});

test('the lock shows where a click is going until the save answers, then the verdict', () => {
  const saving = stepRow(undefined, toggle('unused', undefined));
  assert.equal(lockShownClosed(saving, 'unused'), true, 'locking: closed at once');
  assert.equal(lockShownClosed(stepRow(saving, SETTLED), 'kept'), true);
  // A failed save leaves the verdict as it was, and the lock swings back.
  assert.equal(lockShownClosed(stepRow(saving, SETTLED), 'unused'), false);
  assert.equal(lockShownClosed(stepRow(undefined, toggle('kept', undefined)), 'kept'), false, 'unlocking: open at once');
  assert.equal(lockShownClosed(undefined, 'kept'), true);
  assert.equal(lockShownClosed(undefined, 'unknown'), false);
});

test('held reasons name only the rows that left "Can\'t tell"', () => {
  const rows = stepTransitions(stepTransitions(NO_ROW_TRANSITIONS, 'a|0|0|0', toggle('unknown', 'pieces')), 'b|0|0|0', toggle('unused', undefined));
  assert.deepEqual([...heldReasons(rows)], [['a|0|0|0', 'pieces']]);
});

test('the timings are what the CSS transitions take', () => {
  assert.equal(ROW_TRANSITION_TIMINGS.changeMs, 200);
  assert.equal(ROW_TRANSITION_TIMINGS.collapseMs, 200);
  assert.equal(ROW_TRANSITION_TIMINGS.enterMs, 200);
  assert.ok(ROW_TRANSITION_TIMINGS.collapseFallbackMs > ROW_TRANSITION_TIMINGS.collapseMs, 'the fallback waits past the collapse');
});

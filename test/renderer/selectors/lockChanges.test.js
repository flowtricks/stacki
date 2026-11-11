// Goal: a lock click changes `.stacki/styles.json` so the user sees exactly
// one change. Unlocking one row in a locked stylesheet or folder drops that
// lock and locks every other selector it held by name; locking a stylesheet
// again folds back the name locks only its selectors needed; a split that
// would pass the keep list's bound is refused rather than truncated.
// Method: run the panel's pure change planner through the renderer bundler
// over hand-built reports and keep lists, then apply each change with the
// bridge's own `changedKeepList` (the parser re-checks every bound) and pin
// the resulting file contents.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { unlockOneChange, lockSheetChange, unlockSheetChange } = loadRenderer('src/features/selectors/lockChanges.ts');
const { changedKeepList } = loadRenderer('src/features/selectors/selectorsBridge.ts');
const { parseStyleKeepList, STYLE_KEEP_LIMITS } = loadRenderer('shared/properties/styleKeepList.ts');

const entry = (id, rel, selector, verdict) => ({ id, rel, line: 1, selector, scope: 'global', verdict });
const kept = (name) => ({ kind: 'kept', names: [name] });
const report = {
  entries: [
    entry('p|0|0|0', 'src/styles/patterns.css', '.pattern-a', kept('pattern-a')),
    entry('p|0|5|0', 'src/styles/patterns.css', '.pattern-b', kept('pattern-b')),
    entry('p|0|9|0', 'src/styles/patterns.css', '.hero', { kind: 'used' }),
    entry('u|0|0|0', 'src/styles/utilities.css', '.u-hidden', kept('u-hidden')),
    entry('o|0|0|0', 'src/styles/own/own.css', '.own', kept('own')),
    entry('g|0|0|0', 'src/components/Card.astro', '.shared', kept('shared')),
  ],
  notes: [],
  files: [],
};
const keepList = (lockedStylesheets, keep = []) => parseStyleKeepList({ version: 1, keep, lockedStylesheets });
const row = (selector) => report.entries.find((candidate) => candidate.selector === selector);

test('unlocking one row in a locked stylesheet locks the others by name, in one change', () => {
  const before = keepList(['src/styles/patterns.css']);
  const change = unlockOneChange(report, before, row('.pattern-a'));
  assert.ok(change.ok);
  assert.deepEqual(change.value, { add: ['pattern-b'], remove: [], lock: [], unlock: ['src/styles/patterns.css'] });
  const after = changedKeepList(before, change.value);
  assert.deepEqual(after.keep, ['pattern-b']);
  assert.deepEqual(after.lockedStylesheets, []);
});

test('unlocking one row under a locked folder locks every sheet it covered, except sheets locked on their own', () => {
  const before = keepList(['src/styles/', 'src/styles/own/own.css'], ['pattern-a', 'is-*']);
  const change = unlockOneChange(report, before, row('.pattern-a'));
  assert.ok(change.ok);
  // The row's own exact name lock goes too, or it would stay locked.
  assert.deepEqual(change.value.remove, ['pattern-a']);
  assert.deepEqual(change.value.unlock, ['src/styles/']);
  assert.deepEqual([...change.value.add].sort(), ['pattern-b', 'u-hidden']);
  const after = changedKeepList(before, change.value);
  assert.deepEqual(after.lockedStylesheets, ['src/styles/own/own.css']);
  assert.deepEqual([...after.keep].sort(), ['is-*', 'pattern-b', 'u-hidden']);
});

test('a split past the keep list bound is refused with a clear message, and nothing is truncated', () => {
  const full = Array.from({ length: STYLE_KEEP_LIMITS.patternsMax - 1 }, (_, index) => `name-${index}`);
  const before = keepList(['src/styles/'], full);
  const refused = unlockOneChange(report, before, row('.pattern-a'));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /would lock 3 other styles in src\/styles\/ one by one, past the 1000-name limit.*Unlock src\/styles\/ instead/);
  // One name of room is enough for a sheet with one other selector.
  const room = unlockOneChange(report, keepList(['src/styles/patterns.css'], full), row('.pattern-a'));
  assert.ok(room.ok);
});

test('locking a stylesheet again folds back the name locks only its selectors need', () => {
  const before = keepList([], ['pattern-b', 'u-hidden', 'shared', 'is-*']);
  const change = lockSheetChange(report, before, 'src/styles/patterns.css');
  assert.deepEqual(change, { add: [], remove: ['pattern-b'], lock: ['src/styles/patterns.css'], unlock: [] });
  const folder = lockSheetChange(report, before, 'src/styles/');
  assert.deepEqual(folder.remove, ['pattern-b', 'u-hidden']);
  // A name another sheet's selector needs stays, so locking here unlocks nothing elsewhere.
  const sharedReport = { ...report, entries: [...report.entries, entry('x|0|0|0', 'src/styles/patterns.css', '.shared', kept('shared'))] };
  assert.ok(!lockSheetChange(sharedReport, before, 'src/styles/patterns.css').remove.includes('shared'));
  assert.throws(() => lockSheetChange(report, keepList(['src/styles/patterns.css']), 'src/styles/patterns.css'), /not locked yet/);
  // Split then relock is a round trip.
  const split = keepList(['src/styles/patterns.css']);
  const unlocked = changedKeepList(split, unlockOneChange(report, split, row('.pattern-a')).value);
  const relocked = changedKeepList(unlocked, lockSheetChange(report, unlocked, 'src/styles/patterns.css'));
  assert.deepEqual(relocked, split);
});

test('unlocking a sheet takes only its own entry, and a row outside a locked sheet is a programmer error', () => {
  assert.deepEqual(unlockSheetChange(keepList(['src/styles/']), 'src/styles/'), { add: [], remove: [], lock: [], unlock: ['src/styles/'] });
  assert.throws(() => unlockSheetChange(keepList(['src/styles/']), 'src/styles/patterns.css'), /own entry/);
  assert.throws(() => unlockOneChange(report, keepList([]), row('.pattern-a')), /in a locked stylesheet/);
  assert.throws(() => unlockOneChange(report, keepList(['src/styles/']), row('.hero')), /only a locked row/);
});

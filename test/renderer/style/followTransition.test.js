// Goal: the Follow canvas size state machine (embed/followTransition.ts) is the table in
// docs/style-follow-canvas.md, cell for cell, and a picked row's canvas placement is the width
// following lands on that row at, the toolbar device button's width where it can be.
//   - followTransition: every combination of follow on/off x target Base/not Base x action (the
//     toggle, which is the link click and the "0" key; a pick of the row that holds at the canvas;
//     a pick of a device row; a pick of a row with no canvas width) has one pinned outcome;
//   - rowPlacement: desktop-first and mobile-first rows over the default (narrower than Desktop)
//     breakpoints and over `up` (wider) breakpoints: device rows go to the device width or the
//     query's own boundary, Base to its width or Desktop, motion and hand-typed widths nowhere.
// Method: pure functions over plain data, loaded through the app's bundler; the follow rule a
// placement is checked against is the real followedContextKey with followBreakpoint's unwritten
// desktop-first breakpoint added, exactly as the panel computes it. No React, no timing.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { followTransition, rowPlacement } = loadRenderer('src/features/style/embed/followTransition.ts');
const { followedContextKey } = loadRenderer('src/features/style/model/followWidth.ts');
const { followBreakpoint } = loadRenderer('src/features/style/embed/followBreakpoint.ts');
const { BREAKPOINT_DEFAULTS, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');

const ROOT_FONT_SIZE_PX = 16;
const TOGGLE = { kind: 'toggle' };
const pick = (holdsAtCanvas, placement) => ({ kind: 'pick', holdsAtCanvas, placement });
const DEVICE = { kind: 'width', widthPx: 480 };
const NOWHERE = { kind: 'none' };

// Follow x target x action -> outcome: the doc's table, row for row.
const TABLE = [
  ['on', 'query', 'toggle', TOGGLE, { following: false, target: 'base', canvas: 'keep' }],
  ['on', 'base', 'toggle', TOGGLE, { following: false, target: 'keep', canvas: 'keep' }],
  ['off', 'query', 'toggle', TOGGLE, { following: true, target: 'matched', canvas: 'keep' }],
  ['off', 'base', 'toggle', TOGGLE, { following: true, target: 'matched', canvas: 'keep' }],
  ['on', 'query', 'pick the row at the canvas', pick(true, DEVICE), { following: true, target: 'row', canvas: 'keep' }],
  ['on', 'base', 'pick the row at the canvas', pick(true, NOWHERE), { following: true, target: 'row', canvas: 'keep' }],
  ['on', 'query', 'pick a device row', pick(false, DEVICE), { following: true, target: 'row', canvas: 'move' }],
  ['on', 'base', 'pick a device row', pick(false, DEVICE), { following: true, target: 'row', canvas: 'move' }],
  ['on', 'query', 'pick Desktop-placed Base', pick(false, { kind: 'desktop' }), { following: true, target: 'row', canvas: 'move' }],
  ['on', 'query', 'pick a row with no width', pick(false, NOWHERE), { following: false, target: 'row', canvas: 'keep' }],
  ['on', 'base', 'pick a row with no width', pick(false, NOWHERE), { following: false, target: 'row', canvas: 'keep' }],
  ['off', 'query', 'pick the row at the canvas', pick(true, DEVICE), { following: true, target: 'row', canvas: 'keep' }],
  ['off', 'base', 'pick the row at the canvas', pick(true, NOWHERE), { following: true, target: 'row', canvas: 'keep' }],
  ['off', 'query', 'pick a device row', pick(false, DEVICE), { following: false, target: 'row', canvas: 'keep' }],
  ['off', 'base', 'pick a device row', pick(false, DEVICE), { following: false, target: 'row', canvas: 'keep' }],
  ['off', 'query', 'pick a row with no width', pick(false, NOWHERE), { following: false, target: 'row', canvas: 'keep' }],
  ['off', 'base', 'pick a row with no width', pick(false, NOWHERE), { following: false, target: 'row', canvas: 'keep' }],
];

for (const [follow, target, label, action, expected] of TABLE) {
  test(`follow ${follow}, target ${target}: ${label}`, () => {
    const outcome = followTransition({ following: follow === 'on', targetIsBase: target === 'base' }, action);
    assert.deepEqual(outcome, expected);
  });
}

test('the toggle never moves the canvas and never picks a row, from any state', () => {
  for (const following of [true, false]) {
    for (const targetIsBase of [true, false]) {
      const outcome = followTransition({ following, targetIsBase }, TOGGLE);
      assert.equal(outcome.canvas, 'keep');
      assert.notEqual(outcome.target, 'row');
      assert.equal(outcome.following, !following, 'the toggle always flips following');
    }
  }
});

test('a pick always targets the picked row, and moves the canvas only while following to a placement', () => {
  for (const following of [true, false]) {
    for (const holdsAtCanvas of [true, false]) {
      for (const placement of [DEVICE, NOWHERE, { kind: 'desktop' }]) {
        const outcome = followTransition({ following, targetIsBase: false }, pick(holdsAtCanvas, placement));
        assert.equal(outcome.target, 'row');
        const moves = following && !holdsAtCanvas && placement.kind !== 'none';
        assert.equal(outcome.canvas, moves ? 'move' : 'keep');
      }
    }
  }
});

// The panel's follow rule at a width (useEditorContexts followKeyAt).
const followKeyAt = (rows, breakpoints) => (widthPx) => {
  const target = followBreakpoint(rows, widthPx, breakpoints);
  const all = target === undefined || target.existingKey !== undefined ? rows : [...rows, { key: target.query, embedAtContext: target.query }];
  return followedContextKey(all, widthPx, ROOT_FONT_SIZE_PX);
};
const row = (query) => ({ key: query, embedAtContext: query });
const BASE = { key: '', embedAtContext: '' };
const MOTION = row('@media (prefers-reduced-motion: reduce)');
const CUSTOM = row('@media (width >= 37rem)');
const UP_BREAKPOINTS = resolveBreakpoints([
  { id: 'laptop', name: undefined, direction: 'up', setting: { value: 64, unit: 'rem' } },
  { id: 'tablet', name: undefined, direction: 'up', setting: { value: 48, unit: 'rem' } },
  { id: 'phone', name: undefined, direction: 'up', setting: { value: 30, unit: 'rem' } },
]);

const DESKTOP_FIRST = [BASE, row('@media (width < 64rem)'), row('@media (width < 48rem)'), row('@media (width < 30rem)'), MOTION, CUSTOM];
const MOBILE_FIRST = [BASE, row('@media (width >= 30rem)'), row('@media (width >= 48rem)'), row('@media (width >= 64rem)'), MOTION, CUSTOM];

const PLACEMENTS = [
  // Desktop-first rows over the default breakpoints: each device row at its toolbar button's width.
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, '@media (width < 64rem)', { kind: 'width', widthPx: 1023 }],
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, '@media (width < 48rem)', { kind: 'width', widthPx: 767 }],
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, '@media (width < 30rem)', { kind: 'width', widthPx: 479 }],
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, '', { kind: 'desktop' }],
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, MOTION.key, { kind: 'none' }],
  ['desktop-first', DESKTOP_FIRST, BREAKPOINT_DEFAULTS, CUSTOM.key, { kind: 'none' }],
  // Mobile-first rows named for the default (`<`) breakpoints: the device width is outside the
  // query, so the query's own boundary width, where following picks this row.
  ['mobile-first, down breakpoints', MOBILE_FIRST, BREAKPOINT_DEFAULTS, '@media (width >= 30rem)', { kind: 'width', widthPx: 480 }],
  ['mobile-first, down breakpoints', MOBILE_FIRST, BREAKPOINT_DEFAULTS, '@media (width >= 48rem)', { kind: 'width', widthPx: 768 }],
  ['mobile-first, down breakpoints', MOBILE_FIRST, BREAKPOINT_DEFAULTS, '@media (width >= 64rem)', { kind: 'width', widthPx: 1024 }],
  ['mobile-first, down breakpoints', MOBILE_FIRST, BREAKPOINT_DEFAULTS, '', { kind: 'width', widthPx: 479 }],
  ['mobile-first, down breakpoints', MOBILE_FIRST, BREAKPOINT_DEFAULTS, MOTION.key, { kind: 'none' }],
  // Mobile-first rows over `up` breakpoints: the device width is the boundary itself.
  ['mobile-first, up breakpoints', MOBILE_FIRST, UP_BREAKPOINTS, '@media (width >= 30rem)', { kind: 'width', widthPx: 480 }],
  ['mobile-first, up breakpoints', MOBILE_FIRST, UP_BREAKPOINTS, '@media (width >= 64rem)', { kind: 'width', widthPx: 1024 }],
  ['mobile-first, up breakpoints', MOBILE_FIRST, UP_BREAKPOINTS, CUSTOM.key, { kind: 'none' }],
];

for (const [fixture, rows, breakpoints, key, expected] of PLACEMENTS) {
  test(`${fixture}: picking ${key === '' ? 'Base' : key} puts the canvas at ${JSON.stringify(expected)}`, () => {
    const picked = rows.find((candidate) => candidate.key === key);
    assert.ok(picked, 'the row is in the fixture');
    const rule = followKeyAt(rows, breakpoints);
    const placement = rowPlacement(picked, rows, breakpoints, ROOT_FONT_SIZE_PX, rule);
    assert.deepEqual(placement, expected);
    if (placement.kind === 'width') {
      assert.equal(rule(placement.widthPx), key, 'following at that width picks the same row: no snap after the move');
    }
  });
}

test('a row whose breakpoint width and own width both follow elsewhere has no placement', () => {
  // Two rows on the same boundary: following prefers the first listed, so the second has no width of its own.
  const rows = [BASE, row('@media (width >= 30rem)'), { key: 'nested', embedAtContext: '@media (width >= 30rem)' }];
  const placement = rowPlacement(rows[2], rows, UP_BREAKPOINTS, ROOT_FONT_SIZE_PX, followKeyAt(rows, UP_BREAKPOINTS));
  assert.deepEqual(placement, { kind: 'none' });
});

test('rowPlacement asserts its bounds', () => {
  const rule = () => '';
  assert.throws(() => rowPlacement(BASE, [BASE], BREAKPOINT_DEFAULTS, 0, rule), /rowPlacement: a root font size is positive/);
  const many = Array.from({ length: 513 }, (_, index) => row(`@media (width >= ${index + 1}px)`));
  assert.throws(() => rowPlacement(BASE, many, BREAKPOINT_DEFAULTS, ROOT_FONT_SIZE_PX, rule), /rowPlacement: the row list is within its bound/);
});

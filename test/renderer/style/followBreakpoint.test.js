// Goal: a following panel in a desktop-first component shows the breakpoint that holds at the canvas
// width, even before any rule is written for it, and does nothing in a mobile-first one.
//   - the table (query direction x canvas width) gives the selected breakpoint, its query and whether an
//     existing row stands for it;
//   - the direction is read from the component's own queries (mostly `width >= X` is mobile-first, mostly
//     `width < X` is desktop-first); with none, or an even split, the project's breakpoint settings decide
//     (breakpoints narrower than Desktop are desktop-first), and a project with only wider ones is mobile-first;
//   - the query is the one the Add query form writes, so an existing row for it is reused, never duplicated.
// Method: the pure rule (embed/followBreakpoint.ts) over contexts shaped like the panel's rows and the
// default resolved breakpoints (laptop 1023, tablet 767, phone 479). The panel behaviour (the trigger, held
// mode, the first write) is in followBreakpointPanel.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { followBreakpoint, desktopFirst } = loadRenderer('src/features/style/embed/followBreakpoint.ts');
const { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');

const DEFAULTS = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
const ONLY_UP = resolveBreakpoints([{ id: 'wide', name: undefined, direction: 'up', setting: { value: 100, unit: 'rem' } }]);
const row = (query, key = query) => ({ key, embedAtContext: query });
const BASE = { key: '', embedAtContext: '' };

const none = [BASE];
const mobileFirst = [BASE, row('@media (width >= 30rem)'), row('@media (width >= 48rem)')];
const desktopFirstRows = [BASE, row('@media (width < 64rem)', 'patterns.css\u0000@media (width < 64rem)')];
const evenSplit = [BASE, row('@media (width >= 48rem)'), row('@media (width < 64rem)')];

const pick = (contexts, widthPx, breakpoints = DEFAULTS) => {
  const found = followBreakpoint(contexts, widthPx, breakpoints);
  return found === undefined ? undefined : `${found.breakpointId} ${found.query} ${found.existingKey === undefined ? 'new' : 'existing'}`;
};

test('no queries: the project settings decide, and the canvas breakpoint is the target', () => {
  assert.equal(pick(none, 1440), undefined, 'Desktop is Base');
  assert.equal(pick(none, 1024), undefined, 'one pixel over the laptop boundary is Base');
  assert.equal(pick(none, 1023), 'laptop @media (width < 64rem) new');
  assert.equal(pick(none, 900), 'laptop @media (width < 64rem) new');
  assert.equal(pick(none, 767), 'tablet @media (width < 48rem) new');
  assert.equal(pick(none, 600), 'tablet @media (width < 48rem) new');
  assert.equal(pick(none, 479), 'phone @media (width < 30rem) new');
  assert.equal(pick(none, 320), 'phone @media (width < 30rem) new');
});

test('mobile-first components keep today: nothing is added at any width', () => {
  for (const width of [1440, 1023, 767, 479, 320]) {
    assert.equal(pick(mobileFirst, width), undefined, `${width}px`);
  }
  assert.equal(desktopFirst(mobileFirst, DEFAULTS), false);
});

test('desktop-first components reuse the existing row for a breakpoint that is written', () => {
  assert.equal(pick(desktopFirstRows, 1000), 'laptop @media (width < 64rem) existing');
  assert.equal(pick(desktopFirstRows, 700), 'tablet @media (width < 48rem) new', 'a breakpoint nobody has written yet');
  assert.equal(followBreakpoint(desktopFirstRows, 1000, DEFAULTS).existingKey, 'patterns.css\u0000@media (width < 64rem)');
});

test('an even split falls back to the project settings, not a silent guess', () => {
  assert.equal(desktopFirst(evenSplit, DEFAULTS), true, 'the default breakpoints are narrower than Desktop');
  assert.equal(pick(evenSplit, 700), 'tablet @media (width < 48rem) new');
  assert.equal(desktopFirst(evenSplit, ONLY_UP), false, 'a project with only wider breakpoints is mobile-first');
  assert.equal(pick(evenSplit, 700, ONLY_UP), undefined);
});

test('a project whose breakpoints are all wider than Desktop is mobile-first with no queries', () => {
  assert.equal(pick(none, 700, ONLY_UP), undefined);
  assert.equal(pick(none, 700, []), undefined, 'and with no breakpoints at all');
});

test('queries that are not about width do not vote', () => {
  const motion = [BASE, row('@media (prefers-reduced-motion: reduce)')];
  assert.equal(desktopFirst(motion, DEFAULTS), true, 'no width queries: the settings decide');
  assert.equal(pick(motion, 700), 'tablet @media (width < 48rem) new');
});

// Goal: the style panel's breakpoint trigger never wears a device the canvas toolbar does not show.
// The bug: a mobile-first project (`width >= 48rem` queries, the default `down` breakpoints) at the
// Desktop device, 1033px wide, followed the right query (`>= 48rem`), yet the trigger wore the Tablet
// icon (that row is named for the 48rem boundary) while the toolbar showed Desktop pressed, so it read
// as "not on Desktop". The rule now: while the selected query holds at the canvas width, the trigger
// wears the canvas's device, computed by activeDeviceFor, the very function the toolbar's pressed
// button reads; Base and a query that misses the canvas keep their own icon.
// Method: a table over three fixtures (desktop-first `< X` rows, mobile-first `>= X` rows, and the
// reported heading with only `>= 48rem`) x canvas widths 390, 768, 1033 and 1440 x follow on and off.
// Following, the selected row is the real follow rule's (model/followWidth.ts); held, it is the 48rem
// row. Each case pins the selected row and the trigger icon by name, and, wherever an icon is chosen,
// asserts it is the toolbar's pressed device icon. 1033 and 1440 sit on the Desktop device; 390 and
// 768 are dragged custom widths, as the toolbar labels them by the device the width belongs to.
// The negative space is pinned too: the all-breakpoints canvas, an unmeasured width and a query that
// is not about width choose nothing, and rem boundaries are read at 16px (48rem holds from 768).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { canvasTriggerIcon } = loadRenderer('src/features/style/embed/contextRows.ts');
const { followedContextKey } = loadRenderer('src/features/style/model/followWidth.ts');
const { activeDeviceFor, deviceIconOf } = loadRenderer('shared/properties/breakpointIcon.ts');
const { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');

const DEFAULTS = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
const ROOT_FONT_SIZE_PX = 16;
const BASE = { key: '', embedAtContext: '' };
const row = (query) => ({ key: query, embedAtContext: query });

const FIXTURES = {
  desktopFirst: [BASE, row('@media (width < 64rem)'), row('@media (width < 48rem)'), row('@media (width < 30rem)')],
  mobileFirst: [BASE, row('@media (width >= 30rem)'), row('@media (width >= 48rem)'), row('@media (width >= 64rem)')],
  heading: [BASE, row('@media (width >= 48rem)')],
};
// The row a held panel stays on: each fixture's 48rem query.
const HELD = {
  desktopFirst: '@media (width < 48rem)',
  mobileFirst: '@media (width >= 48rem)',
  heading: '@media (width >= 48rem)',
};
// The toolbar's picked device at each width: Desktop fills the pane at 1033 and 1440; narrower widths are dragged.
const DEVICE_AT = { 390: 'custom', 768: 'custom', 1033: 'desktop', 1440: 'desktop' };

// [fixture, width, follow, the selected row ('' is Base), the trigger icon (undefined keeps the row's own)].
const CASES = [
  ['desktopFirst', 390, 'follow', '@media (width < 30rem)', 'phone'],
  ['desktopFirst', 768, 'follow', '@media (width < 64rem)', 'laptop'],
  ['desktopFirst', 1033, 'follow', '', undefined],
  ['desktopFirst', 1440, 'follow', '', undefined],
  ['desktopFirst', 390, 'held', '@media (width < 48rem)', 'phone'],
  ['desktopFirst', 768, 'held', '@media (width < 48rem)', undefined],
  ['desktopFirst', 1033, 'held', '@media (width < 48rem)', undefined],
  ['desktopFirst', 1440, 'held', '@media (width < 48rem)', undefined],
  ['mobileFirst', 390, 'follow', '', undefined],
  ['mobileFirst', 768, 'follow', '@media (width >= 48rem)', 'laptop'],
  ['mobileFirst', 1033, 'follow', '@media (width >= 64rem)', 'desktop'],
  ['mobileFirst', 1440, 'follow', '@media (width >= 64rem)', 'desktop'],
  ['mobileFirst', 390, 'held', '@media (width >= 48rem)', undefined],
  ['mobileFirst', 768, 'held', '@media (width >= 48rem)', 'laptop'],
  ['mobileFirst', 1033, 'held', '@media (width >= 48rem)', 'desktop'],
  ['mobileFirst', 1440, 'held', '@media (width >= 48rem)', 'desktop'],
  ['heading', 390, 'follow', '', undefined],
  ['heading', 768, 'follow', '@media (width >= 48rem)', 'laptop'],
  // The reported case: Desktop at 1033px follows `>= 48rem` and the trigger wears Desktop, never Tablet.
  ['heading', 1033, 'follow', '@media (width >= 48rem)', 'desktop'],
  ['heading', 1440, 'follow', '@media (width >= 48rem)', 'desktop'],
  ['heading', 390, 'held', '@media (width >= 48rem)', undefined],
  ['heading', 768, 'held', '@media (width >= 48rem)', 'laptop'],
  ['heading', 1033, 'held', '@media (width >= 48rem)', 'desktop'],
  ['heading', 1440, 'held', '@media (width >= 48rem)', 'desktop'],
];

for (const [fixture, widthPx, follow, selected, icon] of CASES) {
  test(`${fixture} at ${widthPx}px, ${follow}: ${selected === '' ? 'Base' : selected} wears ${icon ?? 'its own icon'}`, () => {
    const contexts = FIXTURES[fixture];
    const chosen = follow === 'follow' ? followedContextKey(contexts, widthPx, ROOT_FONT_SIZE_PX) : HELD[fixture];
    assert.equal(chosen, selected, 'the selected row');
    const canvas = { device: DEVICE_AT[widthPx], widthPx };
    const shown = canvasTriggerIcon(chosen, canvas, DEFAULTS);
    assert.equal(shown, icon, 'the trigger icon');
    if (shown !== undefined) {
      const toolbar = deviceIconOf(activeDeviceFor(canvas.device, widthPx, DEFAULTS), DEFAULTS);
      assert.equal(shown, toolbar, 'the trigger icon is the toolbar pressed device icon');
    }
  });
}

test('the reported case never wears the Tablet icon at the Desktop device', () => {
  const shown = canvasTriggerIcon('@media (width >= 48rem)', { device: 'desktop', widthPx: 1033 }, DEFAULTS);
  assert.notEqual(shown, 'tablet', 'not Tablet');
  assert.equal(shown, 'desktop', 'Desktop');
});

test('Desktop keeps its name at any width, as the toolbar does', () => {
  assert.equal(activeDeviceFor('desktop', 900, DEFAULTS), 'desktop', 'a narrow pane still shows Desktop pressed');
  assert.equal(canvasTriggerIcon('@media (width >= 48rem)', { device: 'desktop', widthPx: 900 }, DEFAULTS), 'desktop', 'and so does the trigger');
  assert.equal(activeDeviceFor('custom', 900, DEFAULTS), 'laptop', 'a dragged width is the device it belongs to');
});

test('rem boundaries are read at 16px: 48rem holds from 768, not at 767', () => {
  assert.equal(canvasTriggerIcon('@media (width >= 48rem)', { device: 'custom', widthPx: 768 }, DEFAULTS), 'laptop', '768 is inside');
  assert.equal(canvasTriggerIcon('@media (width >= 48rem)', { device: 'custom', widthPx: 767 }, DEFAULTS), undefined, '767 is outside');
  assert.equal(canvasTriggerIcon('@media (width < 48rem)', { device: 'tablet', widthPx: 767 }, DEFAULTS), 'tablet', 'the Tablet device is inside < 48rem');
});

test('nothing is chosen where the canvas names no one device or the query is not about width', () => {
  assert.equal(canvasTriggerIcon('@media (width >= 48rem)', { device: 'canvas', widthPx: 1033 }, DEFAULTS), undefined, 'the all-breakpoints canvas');
  assert.equal(canvasTriggerIcon('@media (width >= 48rem)', { device: 'desktop', widthPx: undefined }, DEFAULTS), undefined, 'an unmeasured canvas');
  assert.equal(canvasTriggerIcon('@media (hover: hover)', { device: 'desktop', widthPx: 1033 }, DEFAULTS), undefined, 'a hover query');
  assert.equal(canvasTriggerIcon('', { device: 'desktop', widthPx: 1033 }, DEFAULTS), undefined, 'Base');
});

test('an unnamed canvas device is a programmer error', () => {
  assert.throws(() => canvasTriggerIcon('@media (width >= 48rem)', { device: '', widthPx: 1033 }, DEFAULTS), /canvasTriggerIcon: the canvas device is named/);
});

// Goal: a layer popover opens below its row when it fits, above it when only
// that fits, and never runs off the window. The clip-path editor loads after
// the popover mounts, so it was placed for its one-line loading box and stayed
// below the row once the tall editor arrived. Method: the placement function
// over each case, including heights that fit neither side.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { popoverTopFor } = load('src/features/style/LayerPopover.tsx');

const windowHeightPx = 1000;
const row = { top: 800, bottom: 830 };
assert.equal(popoverTopFor(row, 100, windowHeightPx), 836, 'fits below: under the row');
assert.equal(popoverTopFor(row, 500, windowHeightPx), 294, 'too tall for below: above the row');
assert.equal(popoverTopFor({ top: 20, bottom: 50 }, 500, windowHeightPx), 56, 'a row near the top still drops down');
// Fits neither side: as low as it can sit whole, inside the window.
const middle = { top: 480, bottom: 510 };
assert.equal(popoverTopFor(middle, 700, windowHeightPx), 294);
assert.equal(popoverTopFor(middle, 1200, windowHeightPx), 6, 'taller than the window: from the top, scrolling');
assert.throws(() => popoverTopFor(row, -1, windowHeightPx), /a height is not negative/);
console.log('popover placement: ok');

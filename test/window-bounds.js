// How big the window opens.
//
//   node test/window-bounds.js
//
// It opened at a fixed 1480×940, which on anything bigger than a laptop left
// the desk showing around an app that is mostly a canvas. It opens filled now —
// filled meaning the work area, since the menu bar and the Dock belong to the
// OS and a window drawn under them has its title bar out of reach.

const fs = require('fs');
const path = require('path');
const { openingBounds, MIN_WIDTH, MIN_HEIGHT } = require('../electron/windowBounds.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// A 16" laptop: the menu bar is off the top, the Dock off the bottom.
const laptop = { x: 0, y: 38, width: 1728, height: 1079 };
// An external display, second in the layout, so it starts past the first.
const monitor = { x: 1728, y: 0, width: 2560, height: 1415 };

const b = openingBounds(laptop);
check('the window fills the width it is given', b.width === 1728, `${b.width}`);
check('and the height', b.height === 1079, `${b.height}`);
check('starting where the work area starts', b.x === 0 && b.y === 38, `${b.x},${b.y}`);
check('which is under the menu bar, not over it', b.y === laptop.y);

const m = openingBounds(monitor);
check('a second display is filled where it sits', m.x === 1728, `${m.x}`);
check('at its own size', m.width === 2560 && m.height === 1415, `${m.width}×${m.height}`);

// Small displays: the panels have a width below which they stop working, so
// the minimum wins and the window hangs over rather than opening unusable.
const small = openingBounds({ x: 0, y: 0, width: 800, height: 500 });
check('a display below the minimum still gets the minimum', small.width === MIN_WIDTH && small.height === MIN_HEIGHT, `${small.width}×${small.height}`);
check('and the window keeps its minimum size', b.minWidth === MIN_WIDTH && b.minHeight === MIN_HEIGHT);

// Nothing to ask: opening somewhere beats not opening.
check('no work area at all still opens a window', openingBounds().width === MIN_WIDTH);
check('and so does an empty one', openingBounds({}).height === MIN_HEIGHT);

// Fractional bounds are a real thing on scaled displays; a window takes whole
// pixels.
const frac = openingBounds({ x: 0.5, y: 37.5, width: 1727.6, height: 1078.2 });
check(
  'fractional work areas are rounded to whole pixels',
  Number.isInteger(frac.width) && Number.isInteger(frac.height) && Number.isInteger(frac.y),
  JSON.stringify(frac)
);

// --- the app opens with them -------------------------------------------------
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('the window is opened with these bounds', /\.\.\.bounds,/.test(main), 'the window still opens at its own size');
check(
  'measured from the display the pointer is on',
  /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.workArea/.test(main),
  'a second display would open the window on the first'
);
check(
  'and a display it cannot ask about still opens one',
  /catch \{[\s\S]{0,200}openingBounds\(\{ width: 1480, height: 940 \}\)/.test(main),
  'no screen means no window'
);
check('nothing is hard-coded to 1480×940 any more', !/width: 1480,\s*\n\s*height: 940,/.test(main));

if (failures.length) {
  console.error(`\nwindow-bounds: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`window-bounds: ${checked} passed`);

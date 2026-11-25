// How big the window opens.
//
//   node test/electron/app/windowBounds.test.js
//
// It opened at a fixed 1480×940, which on anything bigger than a laptop left
// the desk showing around an app that is mostly a canvas. It opens filled now —
// filled meaning the work area, since the menu bar and the Dock belong to the
// OS and a window drawn under them has its title bar out of reach.

const fs = require('fs');
const path = require('path');
const { openingBounds, WIDTH_PX_MIN, HEIGHT_PX_MIN } = require('#dist/electron/app/windowBounds.js');
const { repoPath } = require('../../helpers/sources.js');
const { readSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// A 16" laptop: the menu bar is off the top, the Dock off the bottom.
const laptop = { x: 0, y: 38, width: 1728, height: 1079 };
// An external display, second in the layout, so it starts past the first.
const monitor = { x: 1728, y: 0, width: 2560, height: 1415 };

const laptopBounds = openingBounds(laptop);
check('the window fills the width it is given', laptopBounds.width === 1728, `${laptopBounds.width}`);
check('and the height', laptopBounds.height === 1079, `${laptopBounds.height}`);
check('starting where the work area starts', laptopBounds.x === 0 && laptopBounds.y === 38, `${laptopBounds.x},${laptopBounds.y}`);
check('which is under the menu bar, not over it', laptopBounds.y === laptop.y);

const monitorBounds = openingBounds(monitor);
check('a second display is filled where it sits', monitorBounds.x === 1728, `${monitorBounds.x}`);
check('at its own size', monitorBounds.width === 2560 && monitorBounds.height === 1415, `${monitorBounds.width}×${monitorBounds.height}`);

// Small displays: the panels have a width below which they stop working, so
// the minimum wins and the window hangs over rather than opening unusable.
const small = openingBounds({ x: 0, y: 0, width: 800, height: 500 });
check('a display below the minimum still gets the minimum', small.width === WIDTH_PX_MIN && small.height === HEIGHT_PX_MIN, `${small.width}×${small.height}`);
check('and the window keeps its minimum size', laptopBounds.minWidth === WIDTH_PX_MIN && laptopBounds.minHeight === HEIGHT_PX_MIN);

// Nothing to ask: opening somewhere beats not opening.
check('no work area at all still opens a window', openingBounds().width === WIDTH_PX_MIN);
check('and so does an empty one', openingBounds({}).height === HEIGHT_PX_MIN);

// Fractional bounds are a real thing on scaled displays; a window takes whole
// pixels.
const frac = openingBounds({ x: 0.5, y: 37.5, width: 1727.6, height: 1078.2 });
check(
  'fractional work areas are rounded to whole pixels',
  Number.isInteger(frac.width) && Number.isInteger(frac.height) && Number.isInteger(frac.y),
  JSON.stringify(frac),
);

// --- the app opens with them -------------------------------------------------
const main = readSource('electron/main.ts');
check('the window is opened with these bounds', /\.\.\.bounds,/.test(main), 'the window still opens at its own size');
check(
  'measured from the display the pointer is on',
  /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.workArea/.test(main),
  'a second display would open the window on the first',
);
check(
  'and a display it cannot ask about still opens one',
  /catch \{[\s\S]{0,200}openingBounds\(\{ width: 1480, height: 940 \}\)/.test(main),
  'no screen means no window',
);
check('nothing is hard-coded to 1480×940 any more', !/width: 1480,\s*\n\s*height: 940,/.test(main));

if (failures.length) {
  console.error(`\nwindow-bounds: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`window-bounds: ${checked} passed`);

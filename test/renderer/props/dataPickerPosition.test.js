// Where the data picker opens beside the field it belongs to.
//
//   node test/renderer/props/dataPickerPosition.test.js
//
// The picker shows each value's name and what it holds on one row, so it is
// wider than a sidebar field. Fields sit at the window's right edge, so the
// wider picker has to slide left to stay on screen. These checks pin the width
// it opens at, the left shift near either edge, the move above the field when
// the field is low in the window, and the assertions on bad anchors.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'data-picker-position.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/props/dataPickerPosition.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { dataPickerPosition, DATA_PICKER_WIDTH_PX_MIN } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
  const viewport = { width: 1400, height: 900 };
  const at = (anchor, options = {}) => dataPickerPosition(anchor, { viewport, ...options });
  const show = (position) => JSON.stringify(position);

  // --- width ---------------------------------------------------------------------
  const narrow = at({ left: 100, bottom: 200, width: 260 });
  check('a narrow field opens the picker at the minimum width', narrow.width === DATA_PICKER_WIDTH_PX_MIN, show(narrow));
  check('with room, it lines up with the field', narrow.left === 100, show(narrow));
  check('just below the field', narrow.top === 204, show(narrow));
  const wide = at({ left: 100, bottom: 200, width: 500 });
  check('a wider field keeps its own width', wide.width === 500, show(wide));

  // --- the window's edges --------------------------------------------------------
  const sidebar = at({ left: 1100, bottom: 200, width: 260 });
  check('near the right edge it slides left', sidebar.left === 1400 - 8 - DATA_PICKER_WIDTH_PX_MIN, show(sidebar));
  check('and ends inside the window', sidebar.left + sidebar.width <= 1392, show(sidebar));
  const leftEdge = at({ left: -40, bottom: 200, width: 100 });
  check('a field off the left edge still opens inside the window', leftEdge.left === 8, show(leftEdge));
  const tiny = dataPickerPosition({ left: 0, bottom: 10, width: 260 }, { viewport: { width: 300, height: 900 } });
  check('a window narrower than the picker shrinks it to fit', tiny.width === 284, show(tiny));
  check('inside both gutters', tiny.left === 8, show(tiny));

  // --- the window's bottom -------------------------------------------------------
  const low = at({ left: 100, bottom: 860, width: 260 });
  check('a low field opens the picker above where it would run off', low.top === 900 - 340, show(low));
  const tall = at({ left: 100, bottom: 860, width: 260 }, { heightPxMax: 564 });
  check('a taller picker climbs further', tall.top === 900 - 564, show(tall));
  const short = dataPickerPosition({ left: 100, bottom: 300, width: 260 }, { viewport: { width: 1400, height: 200 } });
  check('never above the toolbar', short.top === 60, show(short));

  // --- assertions ----------------------------------------------------------------
  const throws = (what, run, message) => {
    try {
      run();
      check(what, false, 'did not throw');
    } catch (error) {
      check(what, String(error).includes(message), String(error));
    }
  };
  throws('a negative anchor width is a bug', () => at({ left: 0, bottom: 0, width: -1 }), 'anchor width must not be negative');
  throws('a NaN anchor is a bug', () => at({ left: Number.NaN, bottom: 0, width: 10 }), 'anchor left must be finite');
  throws('a zero height is a bug', () => at({ left: 0, bottom: 0, width: 10 }, { heightPxMax: 0 }), 'height must be positive');

  if (failures.length) {
    console.error(`\ndata-picker-position: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`data-picker-position: ${checked} passed  [width, edges, and bottom]`);
})();

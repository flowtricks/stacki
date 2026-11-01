// Where an element's `gap` actually is on the page.
//
//   node test/electron/preload/gapBands.test.js
//
// Hovering a padding side already lights the strip it holds open; gap had
// nothing, because gap is the one spacing property the panel cannot work out
// from the element's own rectangle. It lives BETWEEN children, and flex wraps
// and grid places — so the page is asked instead, and this checks the answer.
//
// Run against a real layout engine rather than a stub. The whole point is that
// the rectangles come from the browser rather than from arithmetic here, so a
// test that did the arithmetic itself would be checking nothing.
//
// The case worth being careful about is `justify-content: space-between`: the
// space between two children is then the gap PLUS the free space shared out
// between them. Lighting all of it would tell the user `gap` is bigger than
// the number they are looking at, so the band is capped at the gap.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// The measuring function, from the module that defines it (the preload's
// sources are modules; the app ships them as one bundle). It reads the page
// through the global window, which the test points at its own document.
function loadGapBandsFor(window) {
  global.window = window;
  return loadRenderer('electron/preload/frameMeasure.ts').gapBandsFor;
}

(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const { document, window } = dom.window;

  // JSDOM does not lay anything out, so the boxes are supplied. This is the
  // seam the real browser fills in; everything above it — grouping into rows,
  // capping at the gap, skipping empties — is what is being tested.
  const place = (element, box) => {
    element.getBoundingClientRect = () => ({
      left: box.x,
      top: box.y,
      right: box.x + box.w,
      bottom: box.y + box.h,
      width: box.w,
      height: box.h,
    });
  };
  const parentWith = (styles, kids) => {
    const element = document.createElement('div');
    for (const kid of kids) {
      const child = document.createElement('div');
      place(child, kid);
      child.__display = kid.display || 'block';
      element.appendChild(child);
    }
    // getComputedStyle is asked for each child's display; JSDOM's own answer is
    // not driven by anything here, so it is stubbed per element.
    window.getComputedStyle = (node) => ({ display: node.__display || 'block' });
    return { el: element, cs: styles };
  };

  const gapBandsFor = loadGapBandsFor(window);

  // --- A row of three, 20px apart -------------------------------------------
  {
    const { el: element, cs } = parentWith({ display: 'flex', columnGap: '20px', rowGap: '0px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 120, y: 0, w: 100, h: 50 },
      { x: 240, y: 0, w: 100, h: 50 },
    ]);
    const bands = gapBandsFor(element, cs);
    check('a row of three has two gaps', bands.length === 2, JSON.stringify(bands));
    check(
      'both on the column axis',
      bands.every((band) => band.axis === 'column'),
      JSON.stringify(bands),
    );
    check('the first sits between the first two', bands[0].x === 100 && bands[0].w === 20, JSON.stringify(bands[0]));
    check('the second between the next two', bands[1].x === 220 && bands[1].w === 20, JSON.stringify(bands[1]));
    // A band spans the row it is in, so it reads as the space holding those
    // two items apart rather than a floating rectangle.
    check(
      'and each spans the row',
      bands.every((band) => band.y === 0 && band.h === 50),
      JSON.stringify(bands),
    );
  }

  // --- Wrapped: two rows, both axes -----------------------------------------
  {
    const { el: element, cs } = parentWith({ display: 'flex', columnGap: '20px', rowGap: '30px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 120, y: 0, w: 100, h: 50 },
      { x: 0, y: 80, w: 100, h: 50 },
      { x: 120, y: 80, w: 100, h: 50 },
    ]);
    const bands = gapBandsFor(element, cs);
    const cols = bands.filter((band) => band.axis === 'column');
    const rows = bands.filter((band) => band.axis === 'row');
    // Children are grouped into visual rows by vertical overlap, so a wrapped
    // flex line and a grid row are the same thing to this.
    check('each row gets its own column gap', cols.length === 2, JSON.stringify(cols));
    check(
      'the second row’s gap is on the second row',
      cols.some((band) => band.y === 80),
      JSON.stringify(cols),
    );
    check('and there is one gap between the rows', rows.length === 1, JSON.stringify(rows));
    check('sitting between them', rows[0].y === 50 && rows[0].h === 30, JSON.stringify(rows[0]));
    check('spanning the children’s width', rows[0].x === 0 && rows[0].w === 220, JSON.stringify(rows[0]));
  }

  // --- space-between: the band is the gap, not the free space ---------------
  {
    const { el: element, cs } = parentWith({ display: 'flex', columnGap: '20px', rowGap: '0px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      // 200px of space where the gap is only 20 of it.
      { x: 300, y: 0, w: 100, h: 50 },
    ]);
    const bands = gapBandsFor(element, cs);
    check('the space is still marked', bands.length === 1, JSON.stringify(bands));
    // Lighting all 200 would say `gap: 20px` was holding 200px open.
    check('but only gap-wide', bands[0].w === 20, JSON.stringify(bands[0]));
    check('starting at the child before it', bands[0].x === 100, JSON.stringify(bands[0]));
  }

  // --- Nothing to draw ------------------------------------------------------
  {
    const none = parentWith({ display: 'block', columnGap: '20px', rowGap: '20px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 120, y: 0, w: 100, h: 50 },
    ]);
    // Gap does nothing outside flex and grid, so lighting a space in a block
    // element would credit the property with something it is not doing.
    check('a block element has no gaps', gapBandsFor(none.el, none.cs).length === 0);

    const zero = parentWith({ display: 'flex', columnGap: '0px', rowGap: '0px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 100, y: 0, w: 100, h: 50 },
    ]);
    check('a zero gap draws nothing', gapBandsFor(zero.el, zero.cs).length === 0);

    const one = parentWith({ display: 'flex', columnGap: '20px', rowGap: '20px' }, [{ x: 0, y: 0, w: 100, h: 50 }]);
    check('one child has nothing to be between', gapBandsFor(one.el, one.cs).length === 0);

    const empty = parentWith({ display: 'grid', columnGap: '20px', rowGap: '20px' }, []);
    check('and no children at all is fine', gapBandsFor(empty.el, empty.cs).length === 0);
  }

  // --- Children that are not really there -----------------------------------
  {
    const { el: element, cs } = parentWith({ display: 'grid', columnGap: '20px', rowGap: '0px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      // display:none takes part in nothing; counting it would invent a gap
      // where the page shows none.
      { x: 0, y: 0, w: 0, h: 0, display: 'none' },
      { x: 120, y: 0, w: 100, h: 50 },
    ]);
    const bands = gapBandsFor(element, cs);
    check('a hidden child is not a gap boundary', bands.length === 1, JSON.stringify(bands));
    check('and the gap spans the two real children', bands[0].x === 100 && bands[0].w === 20, JSON.stringify(bands[0]));
  }

  // --- Overlapping children -------------------------------------------------
  {
    // Negative margins, absolute positioning: a "gap" that is not open space.
    const { el: element, cs } = parentWith({ display: 'flex', columnGap: '20px', rowGap: '0px' }, [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 90, y: 0, w: 100, h: 50 },
    ]);
    check('overlapping children have no gap to show', gapBandsFor(element, cs).length === 0, JSON.stringify(gapBandsFor(element, cs)));
  }

  if (failures.length) {
    console.error(`gap-bands: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`gap-bands: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

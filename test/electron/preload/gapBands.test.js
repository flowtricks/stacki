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
  global.document = window.document;
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

  // --- A gap the computed style leaves unresolved ----------------------------
  //
  // A field connected to a variable or a calc() must light its gaps exactly as
  // `16px` does. Variables, em, rem and vw arrive as px in the computed style,
  // but a percentage is kept: `var(--gutter)` holding `calc(2% + 4px)` computes
  // to that same text, which parseFloat read as no gap, and `8.33333%` as an
  // 8px sliver. The measurement now asks the engine, on a probe the size of the
  // content box. JSDOM has no engine, so the probe's box is supplied here from
  // the style it was given: that is the seam, and what is tested is that the
  // probe gets the value and the right basis, and that its answer is used.
  {
    const probes = [];
    const percentOf = (text, basis) => {
      const plain = /^(\d*\.?\d+)%$/.exec(text);
      if (plain) {
        return (basis * Number(plain[1])) / 100;
      }
      const mixed = /^calc\((\d*\.?\d+)% \+ (\d*\.?\d+)px\)$/.exec(text);
      return mixed ? (basis * Number(mixed[1])) / 100 + Number(mixed[2]) : 0;
    };
    const original = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function probeBox() {
      if (!this.hasAttribute('data-avb-probe') || !this.parentElement) {
        return original.call(this);
      }
      const outer = this.parentElement;
      probes.push({ inner: this, outer, attached: outer.isConnected });
      const basisWidth = parseFloat(outer.style.width);
      const basisHeight = parseFloat(outer.style.height);
      const width = percentOf(this.style.width, basisWidth);
      const height = percentOf(this.style.height, basisHeight);
      return { left: 0, top: 0, right: width, bottom: height, width, height };
    };
    const computed = (styles) => ({
      display: 'flex',
      columnGap: '0px',
      rowGap: '0px',
      width: '600px',
      height: '200px',
      boxSizing: 'content-box',
      getPropertyValue: () => '0px',
      ...styles,
    });
    const pair = [
      { x: 0, y: 0, w: 50, h: 20 },
      { x: 150, y: 0, w: 50, h: 20 },
    ];

    try {
      // `gap: var(--columns)` with `--columns: calc(100% / 12)` → 8.33333% of 600.
      const twelfth = parentWith(computed({ columnGap: '8.33333%' }), pair);
      const twelfthBands = gapBandsFor(twelfth.el, twelfth.cs);
      check('a percentage gap draws its band', twelfthBands.length === 1, JSON.stringify(twelfthBands));
      check('at its laid-out width, not the number in front of the %', Math.abs((twelfthBands[0]?.w ?? 0) - 50) < 0.01, JSON.stringify(twelfthBands[0]));

      // A calc() mixing % and px, on a border-box element: the basis is the
      // content box, so padding and border come off the 600px first.
      const sides = { 'padding-left': '20px', 'padding-right': '20px', 'border-left-width': '1px', 'border-right-width': '1px' };
      const mixed = parentWith(computed({ columnGap: 'calc(2% + 4px)', boxSizing: 'border-box', getPropertyValue: (name) => sides[name] ?? '0px' }), pair);
      const mixedBands = gapBandsFor(mixed.el, mixed.cs);
      check('a calc() gap draws its band', mixedBands.length === 1, JSON.stringify(mixedBands));
      check('resolved against the content box', Math.abs((mixedBands[0]?.w ?? 0) - (558 * 0.02 + 4)) < 0.01, JSON.stringify(mixedBands[0]));
      check(
        'the probe was given the content box as its basis',
        probes.some((probe) => probe.outer.style.width === '558px'),
        probes.map((probe) => probe.outer.style.width).join(', '),
      );

      // The row gap resolves against the height, on its own probe.
      const stacked = parentWith(computed({ rowGap: '10%' }), [
        { x: 0, y: 0, w: 50, h: 20 },
        { x: 0, y: 60, w: 50, h: 20 },
      ]);
      const stackedBands = gapBandsFor(stacked.el, stacked.cs);
      check('a percentage row gap draws its band', stackedBands.length === 1 && stackedBands[0]?.axis === 'row', JSON.stringify(stackedBands));
      check('20px: 10% of the 200px height', stackedBands[0]?.h === 20, JSON.stringify(stackedBands[0]));

      // A value the engine will not take leaves the probe at zero: no band, no throw.
      const refused = parentWith(computed({ columnGap: 'nonsense(1)' }), pair);
      check('a value the engine refuses draws nothing', gapBandsFor(refused.el, refused.cs).length === 0);

      check('every probe was on the page while it was measured', probes.length > 0 && probes.every((probe) => probe.attached));
      check(
        'and none is left behind',
        probes.every((probe) => !probe.outer.isConnected),
        String(document.querySelectorAll('[data-avb-probe]').length),
      );

      // Pixels are read as they are: the engine is not asked about a gap it
      // already resolved, so a plain `16px` costs no probe.
      const before = probes.length;
      const plain = parentWith(computed({ columnGap: '16px' }), [
        { x: 0, y: 0, w: 50, h: 20 },
        { x: 66, y: 0, w: 50, h: 20 },
      ]);
      const plainBands = gapBandsFor(plain.el, plain.cs);
      check('a px gap still draws as before', plainBands.length === 1 && plainBands[0]?.w === 16, JSON.stringify(plainBands));
      check('without a probe', probes.length === before, String(probes.length - before));
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect = original;
    }
  }

  if (failures.length) {
    console.error(`gap-bands:${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`gap-bands: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

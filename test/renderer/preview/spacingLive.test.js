// Goal: the band on the canvas is the number in the panel, on the same frame.
// Dragging a side of the spacing box runs the panel's number through every
// value on the way, but the band drawn over the page was sized from the page as
// last measured: the value had to be written, laid out and reported back, a few
// frames behind, and its label came from the hover, so from the file, and kept
// the old value for the whole drag. The drag now hands the canvas its value
// (SpacingHover.live), and the canvas turns it into pixels with the units the
// page reports alongside its measurements.
// Method: the canvas half, on its pure functions. lengthToPx is given every
// kind of value a drag can hold, and the ones only the laid-out page can size
// (a percentage, a variable, a calc(), a unit the page did not price), which
// must come back undefined rather than guessed. withLiveSpacing is checked for
// what it replaces and for everything it must leave alone, by identity. Then
// spacingBands draws the result, as the overlay does. The panel half, a real
// drag reporting to the canvas, is in test/renderer/style/spacingDragReport.
const test = require('node:test');
const assert = require('node:assert/strict');
const { lengthToPx, withLiveSpacing, spacingBands } = require('../../helpers/rendererModule')('src/features/preview/spacingBands.ts');

const units = { em: 20, rem: 16, vw: 12, vh: 8 };
const measured = {
  padding: { top: 16, right: 0, bottom: 16, left: 0 },
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  gaps: [],
  units,
};

test('a length the page priced is turned into pixels', () => {
  const cases = [
    ['12px', 12],
    ['2rem', 32],
    ['1.5em', 30],
    ['10vw', 120],
    ['5vh', 40],
    ['.5rem', 8],
    ['-1rem', -16],
    ['3rem !important', 48],
    ['2REM', 32],
    ['0', 0],
  ];
  for (const [value, px] of cases) {
    assert.equal(lengthToPx(value, units), px, value);
  }
});

test('a value only the laid-out page can size is not guessed', () => {
  for (const value of ['4', '10%', 'var(--space-4)', 'calc(1rem + 2px)', 'auto', '', '1rem 2rem']) {
    assert.equal(lengthToPx(value, units), undefined, value);
  }
  assert.equal(lengthToPx('2rem', {}), undefined, 'a unit the page did not price');
  assert.equal(lengthToPx('2rem', undefined), undefined, 'a page that priced nothing');
  assert.equal(lengthToPx('2rem', { rem: 0 }), undefined, 'a unit worth nothing');
  assert.equal(lengthToPx('12px', undefined), 12, 'px needs no price');
});

test('a dragged side takes the dragged value; the rest keep their measurement', () => {
  const live = withLiveSpacing(measured, 'padding', { top: '3rem' });
  assert.deepEqual(live.padding, { top: 48, right: 0, bottom: 16, left: 0 });
  assert.equal(measured.padding.top, 16, 'the measurement itself is left alone');
  assert.equal(live.margin, measured.margin, 'the other box is untouched');
  assert.equal(live.units, units);
  const margin = withLiveSpacing(measured, 'margin', { left: '-1rem', right: '10%' });
  assert.deepEqual(margin.margin, { top: 0, right: 0, bottom: 0, left: -16 });
});

test('nothing sizable dragged, nothing changed', () => {
  assert.equal(withLiveSpacing(measured, 'padding', { top: 'var(--space-8)' }), measured);
  assert.equal(withLiveSpacing(measured, 'margin', undefined), measured);
  assert.equal(withLiveSpacing(measured, 'padding', {}), measured);
  assert.equal(withLiveSpacing(measured, 'gap', { row: '1rem' }), measured, 'gaps are measured');
  assert.equal(withLiveSpacing(undefined, 'padding', { top: '1rem' }), undefined);
  const unpriced = { padding: { top: 16 } };
  assert.equal(withLiveSpacing(unpriced, 'padding', { top: '2rem' }), unpriced);
});

test('the band passes through every value the panel shows', () => {
  const box = { x: 100, y: 200, w: 400, h: 300 };
  const heights = ['1rem', '2rem', '3rem', '16rem'].map((value) => {
    const sized = withLiveSpacing(measured, 'padding', { top: value });
    return spacingBands(box, sized, 'padding', ['top'])[0]?.h;
  });
  assert.deepEqual(heights, [16, 32, 48, 256]);
  const outside = withLiveSpacing(measured, 'margin', { top: '2rem' });
  const band = spacingBands(box, outside, 'margin', ['top'])[0];
  assert.deepEqual([band?.y, band?.h], [200 - 32, 32], 'a margin band grows outward');
});

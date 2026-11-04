// Goal: pointing at the box a ::before or ::after draws picks that pseudo-element,
// and pointing anywhere else leaves the element itself as the target, so canvas hover
// and click agree with the navigator's pseudo rows.
// Method: the decision is a pure function (electron/preload/pseudoHit.ts) of a point
// and the measured boxes of the elements under it, innermost first. Each rule is
// pinned with literal boxes: a point inside a pseudo box, on its edge, just outside
// it, in a box with no area; ::after over ::before; an inner element's pseudo over an
// outer one's; and the asserted preconditions (finite point, capped candidates), with
// the offset helper that keeps measured boxes relative to their host.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule');
const { pseudoAt, boxAt, PSEUDO_CANDIDATES_MAX } = loadRenderer('electron/preload/pseudoHit.ts');

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
// An icon drawn by ::before at the left of a 200 × 40 button at (100, 100).
const ICON = box(100, 110, 120, 130);
// A badge drawn by ::after, overlapping the icon's right half.
const BADGE = box(110, 100, 130, 120);

test('a point inside a pseudo-element box picks that pseudo-element', () => {
  assert.deepEqual(pseudoAt(105, 120, [{ before: ICON, after: undefined }]), { index: 0, pseudo: 'before' });
  assert.deepEqual(pseudoAt(125, 105, [{ before: undefined, after: BADGE }]), { index: 0, pseudo: 'after' });
});

test('the edge of a pseudo-element box is inside it, a pixel past it is not', () => {
  const only = [{ before: ICON, after: undefined }];
  assert.deepEqual(pseudoAt(100, 110, only), { index: 0, pseudo: 'before' });
  assert.deepEqual(pseudoAt(120, 130, only), { index: 0, pseudo: 'before' });
  assert.equal(pseudoAt(99, 120, only), undefined);
  assert.equal(pseudoAt(121, 120, only), undefined);
  assert.equal(pseudoAt(110, 109, only), undefined);
  assert.equal(pseudoAt(110, 131, only), undefined);
});

test('outside every pseudo-element box the element itself is the target', () => {
  assert.equal(pseudoAt(250, 120, [{ before: ICON, after: BADGE }]), undefined);
  assert.equal(pseudoAt(105, 120, [{ before: undefined, after: undefined }]), undefined);
  assert.equal(pseudoAt(105, 120, []), undefined);
});

test('a box with no area holds no point', () => {
  assert.equal(pseudoAt(100, 120, [{ before: box(100, 110, 100, 130), after: undefined }]), undefined);
  assert.equal(pseudoAt(110, 110, [{ before: box(100, 110, 120, 110), after: undefined }]), undefined);
  // An inverted box, which no measurement produces, holds nothing either.
  assert.equal(pseudoAt(110, 120, [{ before: box(120, 130, 100, 110), after: undefined }]), undefined);
});

test('::after is painted over ::before, so it wins where they overlap', () => {
  const both = [{ before: ICON, after: BADGE }];
  assert.deepEqual(pseudoAt(115, 115, both), { index: 0, pseudo: 'after' });
  // Where only the ::before is, it still answers.
  assert.deepEqual(pseudoAt(105, 125, both), { index: 0, pseudo: 'before' });
});

test('the innermost element whose pseudo-element holds the point wins', () => {
  const inner = { before: ICON, after: undefined };
  // The outer card's ::after is an overlay covering the whole card.
  const outer = { before: undefined, after: box(0, 0, 400, 400) };
  assert.deepEqual(pseudoAt(105, 120, [inner, outer]), { index: 0, pseudo: 'before' });
  assert.deepEqual(pseudoAt(300, 300, [inner, outer]), { index: 1, pseudo: 'after' });
  // An inner element that draws nothing there passes the point outwards.
  assert.deepEqual(pseudoAt(105, 120, [{ before: undefined, after: undefined }, outer]), { index: 1, pseudo: 'after' });
});

test('the point must be finite and the candidates capped', () => {
  assert.throws(() => pseudoAt(Number.NaN, 0, []), /Assertion failed: pseudoAt: x is a finite number/);
  assert.throws(() => pseudoAt(0, Number.POSITIVE_INFINITY, []), /Assertion failed: pseudoAt: y is a finite number/);
  const many = Array.from({ length: PSEUDO_CANDIDATES_MAX + 1 }, () => ({ before: undefined, after: undefined }));
  assert.throws(() => pseudoAt(0, 0, many), /Assertion failed: pseudoAt: candidates are capped/);
  assert.equal(pseudoAt(0, 0, many.slice(0, PSEUDO_CANDIDATES_MAX)), undefined);
});

test('a box kept relative to its host moves with the host', () => {
  // Measured at a host at (100, 100), the page then scrolls the host to (100, 40).
  const offset = boxAt(ICON, -100, -100);
  assert.deepEqual(offset, box(0, 10, 20, 30));
  assert.deepEqual(boxAt(offset, 100, 40), box(100, 50, 120, 70));
  assert.deepEqual(boxAt(offset, 100, 100), ICON);
  assert.throws(() => boxAt(box(20, 0, 10, 10), 0, 0), /Assertion failed: boxAt: the offset box is not inverted horizontally/);
  assert.throws(() => boxAt(box(0, 20, 10, 10), 0, 0), /Assertion failed: boxAt: the offset box is not inverted vertically/);
});

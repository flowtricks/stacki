// Goal: app overlays are drawn where the canvas measured their elements, scaled
// as the selection outlines are, once per place an element renders (or the one
// copy asked for), follow a re-measurement (scroll, resize), draw nothing for an
// element not on the canvas, and ask the canvas to measure exactly their anchors.
// Method: the pure placement functions (src/features/apps/overlayPlacement.ts)
// over hand-made measurement maps, before and after a simulated scroll.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { placeOverlays, overlayAnchorPaths } = load('src/features/apps/overlayPlacement.ts');

const box = (id, anchor) => ({ kind: 'box', id, anchor, color: undefined, fill: undefined, label: undefined, dashed: false, interactive: false });
const pathFor = (nodeId) => ({ hero: '0.1', card: '0.2' })[nodeId];

test('element anchors take the measured boxes, scaled, one per copy', () => {
  const overlays = new Map([['heat-map', [box('a', { nodeId: 'hero', occurrence: undefined }), box('b', { nodeId: 'card', occurrence: 1 })]]]);
  const rects = {
    0.1: [{ x: 10, y: 20, w: 100, h: 50 }],
    0.2: [
      { x: 0, y: 100, w: 30, h: 30 },
      { x: 40, y: 100, w: 30, h: 30 },
    ],
  };
  const placed = placeOverlays(overlays, rects, 0.5, { target: () => undefined }, pathFor);
  assert.deepEqual(
    placed.map(({ item, left, top, width, height, nodeId, copy }) => [item.id, left, top, width, height, nodeId, copy]),
    [
      ['a', 5, 10, 50, 25, 'hero', 0],
      ['b', 20, 50, 15, 15, 'card', 1],
    ],
  );
  // The canvas re-measures after a scroll; the overlay follows.
  const scrolled = placeOverlays(overlays, { ...rects, 0.1: [{ x: 10, y: -180, w: 100, h: 50 }] }, 0.5, { target: () => undefined }, pathFor);
  assert.equal(scrolled[0].top, -90);
});

test('unmeasured or unknown elements draw nothing; viewport rectangles draw as given', () => {
  const overlays = new Map([
    ['heat-map', [box('gone', { nodeId: 'missing', occurrence: undefined }), box('fixed', { rect: { x: 4, y: 8, width: 20, height: 10 } })]],
  ]);
  const placed = placeOverlays(overlays, {}, 2, { target: () => undefined }, pathFor);
  assert.equal(placed.length, 1);
  assert.deepEqual([placed[0].left, placed[0].top, placed[0].width, placed[0].height], [8, 16, 40, 20]);
});

test('the canvas is asked to measure every element anchor once', () => {
  const overlays = new Map([
    ['one', [box('a', { nodeId: 'hero', occurrence: undefined }), box('b', { nodeId: 'hero', occurrence: 0 })]],
    ['two', [box('c', { nodeId: 'card', occurrence: undefined }), box('d', { nodeId: 'missing', occurrence: undefined })]],
  ]);
  assert.deepEqual([...overlayAnchorPaths(overlays, [], { target: () => undefined }, pathFor)].sort(), ['0.1', '0.2']);
});

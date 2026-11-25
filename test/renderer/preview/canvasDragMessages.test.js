// Goal: what the canvas frame says about a drag is parsed at the boundary (src/features/preview/canvasDragMessages.ts),
// and anything a page script could post in its place is refused whole: a drag message that does not parse changes
// nothing, so a forged one can neither move a node nor break the editor's message loop.
//
// Method: one known-good message of each kind passes and comes out as the editor's own shape; then each field of
// each kind is broken in turn (missing, wrong type, not finite, past its bound, a path that is no node path, a flow
// that is no flow, a negative size, one level or child too many) and the message is refused. The same messages go
// through parsePreviewMessage, the canvas's single entry, so the wiring is pinned too.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { parseCanvasDragMessage, CANVAS_DRAG_LIMITS } = load('src/features/preview/canvasDragMessages.ts');
const { parsePreviewMessage } = load('src/features/preview/previewMessages.ts');

const box = { x: 10, y: 20, w: 300, h: 40 };
const level = { path: '0.0', box, content: box, flow: 'column', children: [{ path: '0.0.1', box }] };
const good = {
  start: { type: 'avb:drag-start', path: '0.0.1', occurrence: 0, x: 450, y: 157 },
  over: {
    type: 'avb:drag-over',
    source: 'pointer',
    x: 453,
    y: 163,
    outside: false,
    levels: [level, { path: '', box, content: box, flow: 'block' }],
    dragged: [box],
  },
  end: { type: 'avb:drag-end', source: 'pointer', x: 453, y: 163, outside: false },
  cancel: { type: 'avb:drag-cancel', reason: 'escape' },
};

test('each known-good message parses into the editor’s shape', () => {
  assert.deepEqual(parseCanvasDragMessage(good.start), { kind: 'drag-start', path: '0.0.1', occurrence: 0, x: 450, y: 157 });
  const over = parseCanvasDragMessage(good.over);
  assert.equal(over.kind, 'drag-over');
  assert.equal(over.levels.length, 2);
  assert.deepEqual(over.levels[0].children, [{ path: '0.0.1', box }]);
  assert.equal(over.levels[1].path, '');
  assert.equal(over.levels[1].children, undefined);
  assert.deepEqual(parseCanvasDragMessage(good.end), { kind: 'drag-end', source: 'pointer', x: 453, y: 163, outside: false });
  assert.deepEqual(parseCanvasDragMessage(good.cancel), { kind: 'drag-cancel', reason: 'escape' });
  assert.deepEqual(parseCanvasDragMessage({ ...good.start, path: 'src/components/Card.astro|0.2' }).path, 'src/components/Card.astro|0.2');
});

test('the canvas’s message entry hands drag messages on, and refuses a malformed one', () => {
  assert.deepEqual(parsePreviewMessage(good.cancel), { kind: 'canvas-drag', drag: { kind: 'drag-cancel', reason: 'escape' } });
  assert.equal(parsePreviewMessage({ ...good.cancel, reason: 'whatever' }), undefined);
});

const refusals = [
  ['an unknown type', { ...good.cancel, type: 'avb:drag-sideways' }],
  ['a start without a path', { ...good.start, path: undefined }],
  ['a start whose path is no node path', { ...good.start, path: '0..1' }],
  ['a start whose path is a ::before layer', { ...good.start, path: '0.1::before' }],
  ['a start whose path holds NUL', { ...good.start, path: 'a\u0000|0' }],
  ['a start whose path is past the bound', { ...good.start, path: `${'a'.repeat(CANVAS_DRAG_LIMITS.pathCharsMax)}|0` }],
  ['a start with a negative occurrence', { ...good.start, occurrence: -1 }],
  ['a start with a fractional occurrence', { ...good.start, occurrence: 1.5 }],
  ['a start at a coordinate that is not a number', { ...good.start, x: '450' }],
  ['a start at an infinite coordinate', { ...good.start, y: Number.POSITIVE_INFINITY }],
  ['a start at NaN', { ...good.start, x: Number.NaN }],
  ['a start past the coordinate bound', { ...good.start, x: CANVAS_DRAG_LIMITS.coordinatePxMax + 1 }],
  ['an over from an unknown source', { ...good.over, source: 'mouse' }],
  ['an over without the outside flag', { ...good.over, outside: undefined }],
  ['an over whose levels are not a list', { ...good.over, levels: {} }],
  ['an over with one level too many', { ...good.over, levels: Array.from({ length: CANVAS_DRAG_LIMITS.levelsMax + 1 }, () => level) }],
  ['an over with a level that is not a record', { ...good.over, levels: [7] }],
  ['an over with a level of no known flow', { ...good.over, levels: [{ ...level, flow: 'masonry' }] }],
  ['an over with a level of negative width', { ...good.over, levels: [{ ...level, box: { ...box, w: -1 } }] }],
  ['an over with a level missing its content box', { ...good.over, levels: [{ ...level, content: undefined }] }],
  ['an over with a level whose children are not a list', { ...good.over, levels: [{ ...level, children: 'none' }] }],
  [
    'an over with one child too many',
    { ...good.over, levels: [{ ...level, children: Array.from({ length: CANVAS_DRAG_LIMITS.childrenMax + 1 }, () => ({ path: '0.0.1', box })) }] },
  ],
  ['an over with a child whose path is bad', { ...good.over, levels: [{ ...level, children: [{ path: 'x', box }] }] }],
  ['an over with a child without a box', { ...good.over, levels: [{ ...level, children: [{ path: '0.0.1' }] }] }],
  ['an over with dragged boxes that are not boxes', { ...good.over, dragged: [{ x: 1 }] }],
  ['an over with too many dragged boxes', { ...good.over, dragged: Array.from({ length: CANVAS_DRAG_LIMITS.childrenMax + 1 }, () => box) }],
  ['an end from an unknown source', { ...good.end, source: 'touch' }],
  ['an end without the outside flag', { ...good.end, outside: 'no' }],
  ['a cancel for an unknown reason', { ...good.cancel, reason: 'bored' }],
];

for (const [what, message] of refusals) {
  test(`refused: ${what}`, () => {
    assert.equal(parseCanvasDragMessage(message), undefined);
  });
}

test('valid data as it becomes invalid: the last coordinate in bounds passes and the next one is refused', () => {
  assert.notEqual(parseCanvasDragMessage({ ...good.start, x: CANVAS_DRAG_LIMITS.coordinatePxMax }), undefined);
  assert.notEqual(parseCanvasDragMessage({ ...good.over, levels: Array.from({ length: CANVAS_DRAG_LIMITS.levelsMax }, () => level) }), undefined);
  assert.notEqual(parseCanvasDragMessage({ ...good.over, levels: [{ ...level, box: { ...box, w: 0 } }] }), undefined);
});

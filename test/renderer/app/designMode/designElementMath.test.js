// Goal: the arithmetic of dragging an element in a Design mode frame: a computed translate is read or refused,
// lengths are written in rem, and a drag snaps to the nearest edge or middle within reach and no further.
//
// Method: the real module, bundled by test/helpers/rendererModule.js, on plain boxes, with the negative space
// (units a drag cannot read, a root size of zero, lines out of reach).
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../../helpers/rendererModule');

const { parseTranslate, remLength, snapMove } = load('src/app/designMode/designElementMath.ts');

test('a computed translate is read in pixels; other units are refused', () => {
  assert.deepEqual(parseTranslate('none'), { x: 0, y: 0 });
  assert.deepEqual(parseTranslate('12px'), { x: 12, y: 0 });
  assert.deepEqual(parseTranslate('-4.5px 20px'), { x: -4.5, y: 20 });
  assert.equal(parseTranslate('50% 0px'), undefined);
  assert.equal(parseTranslate('calc(1px + 2%)'), undefined);
});

test('lengths are written in rem of the root size', () => {
  assert.equal(remLength(40, 16), '2.5rem');
  assert.equal(remLength(-8, 16), '-0.5rem');
  assert.equal(remLength(0.0001, 16), '0rem');
  assert.equal(remLength(10, 18), '0.5556rem');
  assert.throws(() => remLength(1, 0), /root size/);
});

test('a drag snaps edges and middles within reach, and not beyond it', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  const other = { x: 200, y: 300, width: 100, height: 50 };
  const near = snapMove(box, { x: 197, y: 120 }, [other], 6);
  assert.deepEqual(near.offset, { x: 200, y: 120 });
  assert.deepEqual(near.guides, [{ axis: 'x', at: 200 }]);
  const far = snapMove(box, { x: 180, y: 120 }, [other], 6);
  assert.deepEqual(far, { offset: { x: 180, y: 120 }, guides: [] });
  assert.deepEqual(snapMove(box, { x: 3, y: 4 }, [], 6), { offset: { x: 3, y: 4 }, guides: [] });
});

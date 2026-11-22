// Goal: the Add elements drag payload is trusted only when it names exactly one thing the editor inserts. A
// payload from another window, a hostile one, or one past its bound is no drop at all.
// Methodology: round-trip every known-good choice (each tag family, each construct, each asset) through the
// writer and the parser, then feed the parser each known-bad shape: empty, oversized, not JSON, JSON that is not
// an object, unknown types and tags, a tag on the wrong type, extra fields, and wrongly typed fields. The writer's
// own precondition is checked too.
const test = require('node:test');
const assert = require('node:assert/strict');
const drag = require('../../helpers/rendererModule')('src/editor/insertDragData.ts');

test('every choice the panel writes reads back as itself', () => {
  const choices = [
    { type: 'element', tag: 'div' },
    { type: 'element', tag: 'h1' },
    { type: 'element', tag: 'svg' },
    { type: 'element', tag: 'Fragment' },
    { type: 'element', tag: 'Content' },
    { type: 'element', tag: 'slot' },
    ...drag.INSERT_DRAG_CONSTRUCTS.map((type) => ({ type })),
    ...drag.INSERT_DRAG_ASSETS.map((name) => ({ type: 'astroAsset', name })),
  ];
  for (const choice of choices) {
    assert.deepEqual(drag.parseInsertDrag(drag.insertDragText(choice)), choice, JSON.stringify(choice));
  }
});

test('empty, oversized and malformed payloads are no drop', () => {
  for (const raw of ['', ' ', 'div', '{', 'null', '[]', '"element"', '42', 'true', `{"type":"element","tag":"div"}${' '.repeat(300)}`]) {
    assert.equal(drag.parseInsertDrag(raw), undefined, JSON.stringify(raw.slice(0, 40)));
  }
});

test('a payload naming anything the editor cannot insert, or two things at once, is refused', () => {
  const refused = [
    {},
    { type: 'component', name: 'Hero' },
    { type: 'node', id: 'n1' },
    { type: 'element' },
    { type: 'element', tag: '' },
    { type: 'element', tag: 'blink' },
    { type: 'element', tag: 'DIV' },
    { type: 'element', tag: 'script onload=x' },
    { type: 'element', tag: 7 },
    { type: 'element', tag: 'div', name: 'Image' },
    { type: 'astroAsset' },
    { type: 'astroAsset', name: 'Video' },
    { type: 'astroAsset', name: 'Image', tag: 'img' },
    { type: 'map', tag: 'div' },
    { type: 'cond', name: 'x' },
    { type: 'MAP' },
    { type: ['map'] },
  ];
  for (const payload of refused) {
    assert.equal(drag.parseInsertDrag(JSON.stringify(payload)), undefined, JSON.stringify(payload));
  }
});

test('the writer refuses a tag the panel never offers', () => {
  assert.throws(() => drag.insertDragText({ type: 'element', tag: 'blink' }), /Assertion failed: insertDragText: the tag is one the panel inserts/);
  assert.equal(drag.isInsertDragTag('section'), true);
  assert.equal(drag.isInsertDragTag('Section'), false);
});

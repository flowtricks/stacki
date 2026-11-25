// Goal: editing one transform or filter layer keeps every function the panel has
// no controls for. The lists were rewritten from the recognised layers alone, so
// matrix(), rotate3d(), a whole-function var(), url() and opacity() filters were
// deleted the moment any other layer was edited, moved or removed.
// Method: the panel's own parsers, hideable rows and serializers, run over mixed
// lists: parse, change one layer (edit, remove, reorder, hide) and compare the
// written text. The negative space: known functions are still editable layers,
// and `none` or a CSS-wide keyword is no layer.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadModule = require('../../helpers/rendererModule');

const transform = loadModule('src/features/style/model/transform.ts');
const filter = loadModule('src/features/style/model/filter.ts');
const hideable = loadModule('src/features/style/model/hideable.ts');

const KINDS = {
  transform: { parse: transform.parseTransforms, serialize: transform.serializeTransforms },
  filter: { parse: filter.parseFilters, serialize: filter.serializeFilters },
};
const rowsOf = (kind, value) => hideable.parseHideable(value, ' ', KINDS[kind].parse);
const textOf = (kind, rows) => hideable.serializeHideable(rows, ' ', KINDS[kind].serialize);
const roundTrip = (kind, value) => textOf(kind, rowsOf(kind, value));
const rawTexts = (kind, value) =>
  rowsOf(kind, value)
    .filter((row) => row.item.type === 'raw')
    .map((row) => row.item.text);

test('unrecognised transform functions stay, verbatim and in place', () => {
  const value =
    'matrix(1, 0, 0, 1, 10, 20) translate3d(1px, 2px, 0px) rotate3d(1, 1, 0, 45deg) var(--tilt) skew(1deg, 0deg) matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)';
  assert.equal(roundTrip('transform', value), value);
  assert.deepEqual(rawTexts('transform', value), [
    'matrix(1, 0, 0, 1, 10, 20)',
    'rotate3d(1, 1, 0, 45deg)',
    'var(--tilt)',
    'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)',
  ]);
});

test('unrecognised filters stay, verbatim and in place', () => {
  const value = 'url(filters.svg#soft) blur(4px) opacity(50%) var(--glow, drop-shadow(0 0 2px red)) invert(100%) drop-shadow(var(--shadow))';
  assert.equal(roundTrip('filter', value), value);
  assert.deepEqual(rawTexts('filter', value), ['url(filters.svg#soft)', 'opacity(50%)', 'var(--glow, drop-shadow(0 0 2px red))', 'drop-shadow(var(--shadow))']);
});

test('editing, removing and reordering other layers keeps them', () => {
  const rows = rowsOf('filter', 'url(a.svg#f) blur(4px) opacity(.5)');
  const edited = rows.map((row, i) => (i === 1 ? { ...row, item: { ...row.item, amount: '8px' } } : row));
  assert.equal(textOf('filter', edited), 'url(a.svg#f) blur(8px) opacity(.5)');
  assert.equal(
    textOf(
      'filter',
      rows.filter((_, i) => i !== 1),
    ),
    'url(a.svg#f) opacity(.5)',
  );
  assert.equal(textOf('filter', [rows[1], rows[2], rows[0]]), 'blur(4px) opacity(.5) url(a.svg#f)');
  // Hiding one comments it out, and it reads back as the same raw layer.
  const hidden = textOf(
    'filter',
    rows.map((row, i) => (i === 2 ? { ...row, hidden: true } : row)),
  );
  assert.equal(hidden, 'url(a.svg#f) blur(4px) /* opacity(.5) */');
  assert.deepEqual(rowsOf('filter', hidden)[2], { item: { type: 'raw', text: 'opacity(.5)' }, hidden: true });
});

test('a rotate run never folds two turns into one, or reorders axes', () => {
  assert.equal(roundTrip('transform', 'rotate(10deg) rotate(20deg)'), 'rotateX(0deg) rotateY(0deg) rotateZ(10deg) rotateX(0deg) rotateY(0deg) rotateZ(20deg)');
  assert.equal(
    roundTrip('transform', 'rotateZ(10deg) rotateX(20deg)'),
    'rotateX(0deg) rotateY(0deg) rotateZ(10deg) rotateX(20deg) rotateY(0deg) rotateZ(0deg)',
  );
  assert.equal(rowsOf('transform', 'rotateX(1deg) rotateY(2deg) rotateZ(3deg)').length, 1);
});

test('functions written without spaces are each read', () => {
  assert.equal(roundTrip('transform', 'matrix(1,0,0,1,0,0)skew(1deg,2deg)'), 'matrix(1,0,0,1,0,0) skew(1deg, 2deg)');
});

test('stray words, a quoted comment opener and a hidden note are not lost', () => {
  assert.equal(roundTrip('filter', 'url("a/*b.svg#f") blur(1px)'), 'url("a/*b.svg#f") blur(1px)');
  assert.equal(roundTrip('filter', 'blur(1px) /* keep this note */'), 'blur(1px) /* keep this note */');
});

test('none and CSS-wide keywords are no layer; known functions are still editable', () => {
  for (const kind of ['transform', 'filter']) {
    for (const value of ['', 'none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']) {
      assert.deepEqual(rowsOf(kind, value), [], `${kind}: ${value}`);
    }
  }
  assert.deepEqual(rawTexts('filter', 'blur(2px) drop-shadow(1px 2px 3px red) hue-rotate(1turn)'), []);
  assert.deepEqual(rawTexts('transform', 'translateX(1px) scale(2) rotate(1deg) skewX(2deg)'), []);
});

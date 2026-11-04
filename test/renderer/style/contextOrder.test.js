// Goal: the style context dropdown lists Base, then the queries the element has
// styles in, then the ones its nearest relatives have styles in, then the rest,
// each group in the order it already had. Method: orderContexts on plain rows
// (groups, stability, duplicates, the bounds), the class index on rules shaped
// like the parser's (subjects only, breakpoint keys, empty and unconditional
// rules skipped), and the relative search on a small page tree (ancestors
// outwards, children downwards, nearest first, the limits), then the pieces
// together, and the negative space: no selection, an unknown id, no relatives.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { CONTEXT_ORDER_LIMITS, indexQueriesByClass, orderContexts, relativeContexts, relativesOf } = load('src/features/style/model/contextOrder.ts');

const row = (key) => ({ key, label: key === '' ? 'Base' : key });
const keysOf = (rows) => rows.map((entry) => entry.key);

// ── orderContexts ────────────────────────────────────────────────────────────
{
  const rows = ['', 'a', 'b', 'c', 'd', 'e'].map(row);
  assert.deepEqual(keysOf(orderContexts(rows, new Set(), [])), ['', 'a', 'b', 'c', 'd', 'e'], 'nothing styled: the order is left alone');
  assert.deepEqual(keysOf(orderContexts(rows, new Set(['d', 'b']), [])), ['', 'b', 'd', 'a', 'c', 'e'], 'own first, in list order, not set order');
  assert.deepEqual(keysOf(orderContexts(rows, new Set(), ['e', 'c'])), ['', 'e', 'c', 'a', 'b', 'd'], "relatives' next, nearest first");
  assert.deepEqual(keysOf(orderContexts(rows, new Set(['d']), ['d', 'e', 'a'])), ['', 'd', 'e', 'a', 'b', 'c'], 'own wins over a relative');
  assert.deepEqual(keysOf(orderContexts(rows, new Set(['']), [''])), ['', 'a', 'b', 'c', 'd', 'e'], 'Base is neither own nor relative: it leads');
  const baseLast = ['a', 'b', ''].map(row);
  assert.deepEqual(keysOf(orderContexts(baseLast, new Set(['b']), ['a'])), ['', 'b', 'a'], 'Base leads wherever it was');
  assert.deepEqual(
    keysOf(orderContexts(rows, new Set(), ['zz', 'c', 'c', 'b'])),
    ['', 'c', 'b', 'a', 'd', 'e'],
    'a relative key not listed adds no row; repeats rank once',
  );
  const twice = ['', 'a', 'b', 'a'].map(row);
  assert.deepEqual(keysOf(orderContexts(twice, new Set(['a']), [])), ['', 'a', 'b'], 'no row twice');
  assert.deepEqual(keysOf(orderContexts([], new Set(['a']), ['b'])), [], 'no rows, no rows');
  const same = orderContexts(rows, new Set(['c']), []);
  assert.equal(same[1], rows[3], 'the rows themselves are returned, not copies');
  const tooMany = Array.from({ length: CONTEXT_ORDER_LIMITS.contextsMax + 1 }, (_, index) => row(`q${index}`));
  assert.throws(() => orderContexts(tooMany, new Set(), []), /orderContexts: more contexts than the limit/);
  assert.throws(
    () =>
      orderContexts(
        rows,
        new Set(),
        tooMany.map((entry) => entry.key),
      ),
    /orderContexts: more relative contexts than the limit/,
  );
}

// ── indexQueriesByClass ──────────────────────────────────────────────────────
const rule = (atContext, selectors, declarationCount = 1) => ({
  atContext,
  selectors: selectors.map((text) => ({ text })),
  declarations: Array.from({ length: declarationCount }, () => ({})),
});
const keyOf = (atContext) => (atContext === '@media (max-width: 767px)' ? 'bp:small' : atContext);
const rules = [
  rule([], ['.card']),
  rule(['@media (width < 50rem)'], ['.card .title']),
  rule(['@media (width < 65rem)'], ['.card.is-open', '.other']),
  rule(['@media (max-width: 767px)'], ['.hero']),
  rule(['@container (width > 40em)'], ['.empty'], 0),
  rule(['@media print'], ['div', '[data-x]']),
  rule(['@supports (display: grid)', '@media (width < 50rem)'], ['.grid']),
];
const index = indexQueriesByClass(rules, keyOf);
assert.deepEqual(
  index.get('card').map((entry) => entry.classes.join('.')),
  ['card.is-open'],
  'a rule outside any query is not filed, and `.card .title` files under its subject, not `.card`',
);
assert.deepEqual(
  index.get('title').map((entry) => entry.contextKey),
  ['@media (width < 50rem)'],
);
assert.deepEqual(index.get('is-open'), [{ classes: ['card', 'is-open'], contextKey: '@media (width < 65rem)' }], 'a compound files all its classes');
assert.deepEqual(
  index.get('hero').map((entry) => entry.contextKey),
  ['bp:small'],
  'a breakpoint query is keyed the way the dropdown keys it',
);
assert.equal(index.get('empty'), undefined, 'a rule with no declarations styles nothing');
assert.deepEqual(
  index.get('grid').map((entry) => entry.contextKey),
  ['@supports (display: grid) › @media (width < 50rem)'],
  'a nested query keeps its chain',
);
assert.equal(
  [...index.values()].some((entries) => entries.some((entry) => entry.contextKey === '@media print')),
  false,
  'a classless subject is not filed',
);

// ── relativesOf ──────────────────────────────────────────────────────────────
const element = (id, classes, children = []) => ({
  id,
  kind: 'element',
  name: 'div',
  props: classes === undefined ? {} : { class: { type: 'string', value: classes } },
  children,
});
const tree = [
  element('page', 'page', [
    element('card', 'card', [
      element('wrapper', undefined, [
        element('title', 'title', [element('icon', 'icon', [element('glyph', 'glyph', [element('deep', 'deep')])])]),
        element('label', 'label'),
      ]),
    ]),
  ]),
];
const ofTitle = relativesOf(tree, 'title');
assert.deepEqual(
  ofTitle.map((relative) => [relative.classes.join(' '), relative.distance]),
  [
    ['icon', 1],
    ['card', 2],
    ['glyph', 2],
    ['page', 3],
    ['deep', 3],
  ],
  'nearest first, an ancestor before a child at the same distance, classless wrappers skipped but counted',
);
assert.equal(
  relativesOf(tree, 'title').some((relative) => relative.classes.includes('label')),
  false,
  'a sibling is not a relative',
);
assert.deepEqual(relativesOf(tree, undefined), [], 'no selection, no relatives');
assert.deepEqual(relativesOf(tree, 'missing'), [], 'an id not in the tree, no relatives');
assert.deepEqual(relativesOf([element('alone', 'alone')], 'alone'), [], 'a lone node has none');

// The bounds: a deep chain stops at the ancestor limit, a wide one at the
// descendant limit, and the deepest children are not asked at all.
{
  let chain = element('leaf', 'leaf');
  for (let level = 0; level < CONTEXT_ORDER_LIMITS.relativeAncestorsMax + 4; level++) {
    chain = element(`level${level}`, `level${level}`, [chain]);
  }
  const ancestors = relativesOf([chain], 'leaf');
  assert.equal(ancestors.length, CONTEXT_ORDER_LIMITS.relativeAncestorsMax, 'ancestors stop at the limit');
  assert.equal(ancestors[0].classes[0], 'level0', 'starting from the parent');
  const wide = element(
    'root',
    'root',
    Array.from({ length: CONTEXT_ORDER_LIMITS.relativeDescendantsMax + 10 }, (_, index) => element(`child${index}`, `child${index}`)),
  );
  assert.equal(relativesOf([wide], 'root').length, CONTEXT_ORDER_LIMITS.relativeDescendantsMax, 'descendants stop at the limit');
  assert.equal(
    ofTitle.some((relative) => relative.distance > CONTEXT_ORDER_LIMITS.relativeDescendantDepthMax && relative.classes.includes('deep')),
    false,
    'no child below the depth limit',
  );
}

// ── relativeContexts, and the whole order ────────────────────────────────────
{
  const sheet = indexQueriesByClass(
    [
      rule(['@media (width < 50rem)'], ['.page']),
      rule(['@media (width < 65rem)'], ['.card']),
      rule(['@media (width < 80rem)'], ['.icon']),
      rule(['@media (width < 90rem)'], ['.card.is-open']),
      rule(['@media (width < 65rem)'], ['.glyph']),
    ],
    keyOf,
  );
  const ranked = relativeContexts(relativesOf(tree, 'title'), sheet);
  assert.deepEqual(ranked, ['@media (width < 80rem)', '@media (width < 65rem)', '@media (width < 50rem)'], 'nearest relative first, each query once');
  assert.equal(ranked.includes('@media (width < 90rem)'), false, 'a compound the relative only half writes does not count');
  assert.deepEqual(relativeContexts([], sheet), [], 'no relatives, no queries');

  const dropdown = ['', '@media (width < 50rem)', '@media (width < 65rem)', '@media (width < 80rem)', '@media (width < 90rem)', 'bp:small'].map(row);
  assert.deepEqual(
    keysOf(orderContexts(dropdown, new Set(['bp:small']), ranked)),
    ['', 'bp:small', '@media (width < 80rem)', '@media (width < 65rem)', '@media (width < 50rem)', '@media (width < 90rem)'],
    'Base, own, relatives nearest first, then the rest',
  );
}

console.log('context order: ok');

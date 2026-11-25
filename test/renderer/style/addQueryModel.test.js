// Goal: the Add query form offers the project's breakpoints correctly. The direction only decides
// the operator (Mobile first `width >= X`, Desktop first `width < X`) over the breakpoint's own
// number and unit; suggestions come in the preview bar's order, including added `up` ones and
// custom names; a condition that already exists is found; the project's convention (mobile first,
// desktop first, none) picks the default direction; and the Custom row reads a width by the
// Settings editor's rules, converts a typed px to rem for a rem-only (Lumos) project, and keeps a
// hand-typed at-rule as written.
// Method: the pure model (embed/addQueryModel.ts) over tables of cases with the real shared
// resolver, including the negative space (garbage text, decimal px, out-of-range widths, ranges and
// non-width queries not voting, no queries at all). No DOM, no timing.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const model = loadRenderer('src/features/style/embed/addQueryModel.ts');
const { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');
const { queryFor, conditionFor, detectConvention, defaultDirection, existingQueryKey, suggestionsFor, parseCustom, suggestionMatches } = model;

const DEFAULTS = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
const PX = { kind: 'px' };
const LUMOS = { kind: 'rem', rootFontPx: 16 };
const row = (key, embedAtContext) => ({ key, embedAtContext });

test("the direction decides the operator over the breakpoint's own number and unit", () => {
  const laptop = { value: 64, unit: 'rem' };
  assert.equal(queryFor(laptop, 'up'), '@media (width >= 64rem)');
  assert.equal(queryFor(laptop, 'down'), '@media (width < 64rem)');
  assert.equal(conditionFor({ value: 1100, unit: 'px' }, 'up'), 'width >= 1100px');
  assert.equal(conditionFor({ value: 62.5, unit: 'rem' }, 'down'), 'width < 62.5rem');
});

test('suggestions are the project list in bar order, for either direction', () => {
  const list = resolveBreakpoints([
    { id: 'bp-tv', name: 'TV', direction: 'up', setting: { value: 120, unit: 'rem' } },
    { id: 'bp-xl', name: undefined, direction: 'up', setting: { value: 100, unit: 'rem' } },
    ...BREAKPOINT_DEFAULT_LIST,
    { id: 'bp-watch', name: 'Watch', direction: 'down', setting: { value: 20, unit: 'rem' } },
  ]);
  const up = suggestionsFor(list, 'up', []);
  assert.deepEqual(
    up.map((suggestion) => suggestion.query),
    [
      '@media (width >= 120rem)',
      '@media (width >= 100rem)',
      '@media (width >= 64rem)',
      '@media (width >= 48rem)',
      '@media (width >= 30rem)',
      '@media (width >= 20rem)',
    ],
    'mobile first: a down breakpoint offers the form for the chosen direction, with its own boundary',
  );
  const down = suggestionsFor(list, 'down', []);
  assert.deepEqual(
    down.map((suggestion) => suggestion.condition),
    ['width < 120rem', 'width < 100rem', 'width < 64rem', 'width < 48rem', 'width < 30rem', 'width < 20rem'],
    'desktop first: an up breakpoint also offers its boundary',
  );
  assert.deepEqual(
    down.map((suggestion) => suggestion.breakpoint.id),
    list.map((breakpoint) => breakpoint.id),
    "in the list's own (the preview bar's) order",
  );
  assert.ok(up.every((suggestion) => suggestion.existingKey === undefined));
});

test('an existing condition is found by boundary, side and operator, in px or rem', () => {
  const contexts = [
    row('a', '@media (width >= 48rem)'),
    row('b', '@media (max-width: 1023px)'),
    row('c', '@media (width < 30rem)'),
    row('d', '@media (min-width: 1024px)'),
  ];
  const tablet = { value: 48, unit: 'rem' };
  assert.equal(existingQueryKey(contexts, tablet, 'up'), 'a');
  assert.equal(existingQueryKey(contexts, tablet, 'down'), undefined, 'the other operator is another query');
  assert.equal(existingQueryKey(contexts, { value: 30, unit: 'rem' }, 'down'), 'c');
  assert.equal(existingQueryKey(contexts, { value: 64, unit: 'rem' }, 'up'), 'd', 'px for rem');
  assert.equal(existingQueryKey(contexts, { value: 64, unit: 'rem' }, 'down'), undefined, 'max-width: 1023px is a different boundary');
  assert.equal(
    existingQueryKey([row('r', '@media (30rem <= width < 48rem)'), row('p', '@media print')], tablet, 'up'),
    undefined,
    'a range or another kind is not the same query',
  );
  const marked = suggestionsFor(DEFAULTS, 'up', [row('a', '@media (width >= 48rem)')]);
  assert.deepEqual(
    marked.map((suggestion) => suggestion.existingKey),
    [undefined, 'a', undefined],
  );
});

test('the convention is the majority of width queries, mobile first when there is none', () => {
  assert.equal(detectConvention(['@media (width >= 30rem)', '@media (width >= 48rem)', '@media (width < 20rem)']), 'up');
  assert.equal(detectConvention(['@media (max-width: 991px)', '@media (width < 30rem)', '@media (min-width: 40rem)']), 'down');
  assert.equal(detectConvention([]), undefined);
  assert.equal(detectConvention(['@media (width >= 30rem)', '@media (width < 20rem)']), undefined, 'an even split is no convention');
  assert.equal(
    detectConvention(['@media (prefers-color-scheme: dark)', '@media (30rem <= width < 48rem)', '@container c (width > 20rem)']),
    undefined,
    'ranges and other queries do not vote',
  );
  assert.equal(defaultDirection([]), 'up');
  assert.equal(defaultDirection(['@media (width < 30rem)']), 'down');
  assert.equal(defaultDirection(['@media (width >= 30rem)']), 'up');
});

test('the Custom row reads a width by the Settings rules and says what it will write', () => {
  const read = (text, lengthUnit = PX, direction = 'up', contexts = []) => parseCustom(text, { direction, lengthUnit, contexts });
  assert.deepEqual(read(''), { kind: 'empty' });
  assert.deepEqual(read('  @ '), { kind: 'empty' });
  assert.deepEqual(read('40rem').query, '@media (width >= 40rem)');
  assert.equal(read('1100px').query, '@media (width >= 1100px)');
  assert.equal(read('1100').query, '@media (width >= 1100px)', 'a bare number is px');
  assert.equal(read('62.5rem', PX, 'down').query, '@media (width < 62.5rem)');
  assert.equal(read('40 REM').query, '@media (width >= 40rem)');
  assert.deepEqual(read('1100.5px'), { kind: 'invalid', code: 'pxWhole' });
  assert.deepEqual(read('40.12345rem'), { kind: 'invalid', code: 'syntax' }, 'rem to four decimals');
  assert.deepEqual(read('banana'), { kind: 'invalid', code: 'syntax' });
  assert.deepEqual(read('-5rem'), { kind: 'invalid', code: 'syntax' });
  assert.deepEqual(read('5px'), { kind: 'invalid', code: 'range' }, 'below what the canvas can show');
  assert.deepEqual(read('99999rem'), { kind: 'invalid', code: 'range' });
  assert.deepEqual(read('@media (hover: hover)'), { kind: 'raw', query: '@media (hover: hover)' }, 'a typed at-rule is kept as written');
  const lumos = read('1100px', LUMOS);
  assert.equal(lumos.query, '@media (width >= 68.75rem)', 'a rem-only project converts px at its root font size');
  assert.equal(lumos.converted, true);
  assert.equal(read('40rem', LUMOS).converted, false);
  assert.equal(parseCustom('1000px', { direction: 'up', lengthUnit: { kind: 'rem', rootFontPx: 10 }, contexts: [] }).query, '@media (width >= 100rem)');
  assert.equal(read('48rem', PX, 'up', [row('a', '@media (width >= 48rem)')]).existingKey, 'a', 'a typed width that exists is not added twice');
  assert.equal(read('768px', LUMOS, 'up', [row('a', '@media (width >= 48rem)')]).existingKey, 'a', 'also after conversion');
});

test('typing narrows the suggestions by name, number and width', () => {
  const [laptop] = suggestionsFor(DEFAULTS, 'up', []);
  assert.equal(suggestionMatches(laptop, '', 'Laptop'), true);
  assert.equal(suggestionMatches(laptop, 'lap', 'Laptop'), true);
  assert.equal(suggestionMatches(laptop, '64', 'Laptop'), true);
  assert.equal(suggestionMatches(laptop, '1023', 'Laptop'), true);
  assert.equal(suggestionMatches(laptop, 'tab', 'Laptop'), false);
  assert.equal(suggestionMatches(laptop, '@media (hover: hover)', 'Laptop'), true, 'a hand-typed at-rule narrows nothing');
});

test('the lists are bounded', () => {
  const big = Array.from({ length: model.ADD_QUERY_ENTRIES_MAX + 1 }, (_, index) => row(`k${index}`, '@media (width >= 1px)'));
  assert.throws(() => detectConvention(big.map((entry) => entry.embedAtContext)), /bounded/);
  assert.throws(() => existingQueryKey(big, { value: 1, unit: 'px' }, 'up'), /bounded/);
});

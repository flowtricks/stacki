// Goal: a variable search puts the names that start like the query first, the way the user typed
// it: `--space-` finds `--space-1` before any variable whose VALUE mentions `var(--space-7)`.
// Method: the pure ranking (variableSearch.ts) is driven with the reported project: names
// space-1 to space-10 beside variables whose values are `var(--space-7)` and a clamp of
// `--section-space-*`. Each tier is pinned in order, then the negative space: no match, an empty
// query, case, hidden names the caller already removed, and group order following the best member.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { rankVariables, rankVariable, bestRank, queryWords } = load('src/features/style/variableSearch.ts');

let checked = 0;
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checked++;
};
const variable = (name, value = '1rem', group = '', collection = 'src/styles/base.css') => ({
  name,
  value,
  group,
  collection,
  binding: `var(--${name})`,
  type: 'Size',
});
const names = (list) => list.map((item) => item.name);

const spaces = Array.from({ length: 10 }, (_, index) => variable(`space-${10 - index}`, `${index}rem`));
const project = [
  variable('top', 'var(--space-7)', 'display-margin'),
  variable('bottom', 'var(--space-6)', 'display-margin'),
  variable('section-space-nav-overlap', 'clamp(var(--section-space-nav), 1rem, 2rem)'),
  variable('h1-margin', 'var(--space-7)', 'h1'),
  ...spaces,
];

// The reported case, with and without the leading dashes, in natural order.
for (const query of ['--space-', 'space-', '--SPACE-']) {
  const found = names(rankVariables(project, query));
  equal(
    found.slice(0, 10),
    ['space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6', 'space-7', 'space-8', 'space-9', 'space-10'],
    `names first, natural order: ${query}`,
  );
  equal(found[10], 'section-space-nav-overlap', `then the word-boundary name: ${query}`);
  equal(found.slice(11).sort(), ['bottom', 'h1-margin', 'top'], `then the values: ${query}`);
}

// Tier by tier.
const tiers = [
  variable('space', 'x'),
  variable('space-1', 'x'),
  variable('a-space', 'x'),
  variable('aspace', 'x'),
  variable('v-prefix', 'space-3'),
  variable('v-contains', 'calc(1 + space-3)'),
  variable('z-scope', 'x', 'space-group'),
];
equal(
  names(rankVariables([...tiers].reverse(), 'space')),
  ['space', 'space-1', 'a-space', 'aspace', 'v-prefix', 'v-contains', 'z-scope'],
  'exact, prefix, word, contains, value, scope',
);
equal(names(rankVariables([variable('fooBarBaz'), variable('xbar')], 'bar')), ['fooBarBaz', 'xbar'], 'a camelCase hump is a word boundary');
equal(names(rankVariables([variable('a.b'), variable('ab')], 'b')), ['a.b', 'ab'], 'a dot is a word boundary');
equal(rankVariable(variable('a'), 'nope'), undefined, 'no match');
equal(names(rankVariables(project, 'zzz')), [], 'no matches at all');
equal(names(rankVariables(project, '   ')), names(project), 'an empty query keeps the order given');
equal(rankVariables(project, '--').length, project.length, 'a bare -- matches everything');
equal(names(rankVariables(project, '--')).slice(0, 3), ['bottom', 'h1-margin', 'section-space-nav-overlap'], 'in natural name order');
equal(names(rankVariables([variable('Space-2'), variable('space-1')], 'SPACE')), ['space-1', 'Space-2'], 'case does not matter');
equal(names(rankVariables([variable('b'), variable('a')], 'x-nothing')), [], 'nothing leaks in');
equal(
  names(rankVariables([variable('btn-bg-hover'), variable('btn-bg'), variable('btn')], 'btn bg')),
  ['btn-bg', 'btn-bg-hover'],
  'several words must all match',
);
equal(queryWords('--a  B'), ['a', 'b'], 'words lose their dashes and case');

// Groups follow their best member.
const groups = [variable('x1', 'var(--space-7)', 'one'), variable('x2', 'var(--space-6)', 'one'), variable('space-1', '1', 'two')];
equal(
  bestRank(groups.slice(0, 2), '--space-') > bestRank(groups.slice(2), '--space-'),
  true,
  'a group with only value matches ranks after one with a name match',
);
equal(bestRank([], 'a'), undefined, 'an empty group has no rank');

console.log(`variable-search: ${checked} passed`);

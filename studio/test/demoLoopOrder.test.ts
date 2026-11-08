// Goal: a loop over a frontmatter array of literals can be filtered, sorted and
// limited in the demo, from the copies of its body the bake rendered, and only then.
// The order computed here must match what the code Studio writes would compute, and
// anything that code could do that the demo cannot reproduce keeps the refusal.
// Method: the reader on literal and non-literal constants; queries run against the
// same arrays as the JavaScript loopQuery.ts writes, evaluated here as the oracle;
// then whole page edits through the plan, positive and negative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astroConditionCode, astroComparatorCode, sliceCode, type LoopQuery } from '../vendor/stacki/src/editor/loopQuery';
import { literalArray, loopRun, queryOrder } from '../demo/loopOrder';
import { NOT_SHOWN, planPageChange, settingsLockReason } from '../demo/pageChange';

const ITEMS = [
  { title: 'Gamma', span: 7, tags: ['a'], live: true, date: '2024-03-01', label: 'Staff 10' },
  { title: 'alpha', span: 5, tags: [], live: false, date: '2023-01-15', label: 'Staff 2' },
  { title: 'Beta', span: 6, tags: ['a', 'b'], date: '2025-07-04', label: 'staff 1' },
  { title: 'Delta', span: 5, live: true, label: 'Staff 2' },
];

function query(change: Partial<Pick<LoopQuery, 'conditions' | 'sorts' | 'offset' | 'limit' | 'match' | 'random' | 'customSort'>>): LoopQuery {
  return {
    source: { kind: 'list', collection: 'items' },
    match: 'all',
    conditions: [],
    sorts: [],
    random: false,
    offset: 0,
    limit: undefined,
    projection: undefined,
    parameter: { kind: 'entry', name: 'item' },
    ...change,
  };
}

/** Code Studio writes, compiled and called: the oracle the demo must agree with. */
function compiled(parameters: readonly string[], body: string): (...values: readonly unknown[]) => unknown {
  const made: unknown = new Function(...parameters, body);
  assert.ok(typeof made === 'function');
  return (...values) => {
    const result: unknown = Reflect.apply(made, undefined, values);
    return result;
  };
}

function oracle(input: LoopQuery): readonly number[] {
  const joiner = input.match === 'all' ? ' && ' : ' || ';
  const filter = compiled(
    ['item'],
    `return ${input.conditions.length === 0 ? 'true' : input.conditions.map((condition) => astroConditionCode(condition, 'item')).join(joiner)};`,
  );
  const comparator = input.sorts.length === 0 ? undefined : compiled([], `return ${astroComparatorCode(input.sorts, [])};`)();
  const compare = (left: unknown, right: unknown): number => Number(typeof comparator === 'function' ? Reflect.apply(comparator, undefined, [left, right]) : 0);
  const kept = ITEMS.map((item, index) => ({ item, index })).filter(({ item }) => filter(item) === true);
  const sorted = comparator === undefined ? kept : kept.toSorted((left, right) => compare(left.item, right.item));
  const slice = compiled(['list'], `return list${sliceCode(input.offset, input.limit)};`)(sorted);
  assert.ok(Array.isArray(slice));
  return slice.map((entry: unknown) => (typeof entry === 'object' && entry !== null && 'index' in entry ? Number(entry.index) : -1));
}

test('a constant of literals reads as data; anything else does not', () => {
  assert.deepEqual(literalArray('const items = ["a", \'b\', `c`, 1, -2.5, true, null,];', 'items'), ['a', 'b', 'c', 1, -2.5, true, null]);
  assert.deepEqual(literalArray('const items = [{ shot: "text" as const, "x-y": [1] }] as const;', 'items'), [{ shot: 'text', 'x-y': [1] }]);
  assert.equal(literalArray('const items = [{ icon: appCanvas }];', 'items'), undefined, 'A name holds what only the page knows');
  assert.equal(literalArray('const items = [`${x}`];', 'items'), undefined, 'A template with a value');
  assert.equal(literalArray('const items = [load()];', 'items'), undefined, 'A call');
  assert.equal(literalArray('const items = [{ title }];', 'items'), undefined, 'A shorthand property');
  assert.equal(literalArray('const other = [1];', 'items'), undefined, 'No such constant');
});

test('each condition, sort and slice gives the order the written code gives', () => {
  const cases: readonly LoopQuery[] = [
    query({}),
    query({ conditions: [{ kind: 'test', field: 'span', operator: 'greater', value: 5 }] }),
    query({ conditions: [{ kind: 'test', field: 'title', operator: 'contains', value: 'TA' }] }),
    query({ conditions: [{ kind: 'test', field: 'live', operator: 'isTrue' }] }),
    query({ conditions: [{ kind: 'test', field: 'live', operator: 'isFalse' }] }),
    query({ conditions: [{ kind: 'test', field: 'date', operator: 'isSet' }] }),
    query({ conditions: [{ kind: 'test', field: 'tags', operator: 'has', value: { kind: 'text', text: 'b' } }] }),
    query({ conditions: [{ kind: 'test', field: 'title', operator: 'is', value: { kind: 'text', text: 'Beta' } }] }),
    query({ conditions: [{ kind: 'test', field: 'date', operator: 'before', value: '2024-06-01' }] }),
    query({
      match: 'any',
      conditions: [
        { kind: 'test', field: 'span', operator: 'atMost', value: 5 },
        { kind: 'test', field: 'title', operator: 'isNot', value: { kind: 'text', text: 'Gamma' } },
      ],
    }),
    query({ sorts: [{ field: 'title', direction: 'ascending', order: 'text' }] }),
    query({
      sorts: [
        { field: 'span', direction: 'descending', order: 'number' },
        { field: 'title', direction: 'ascending', order: 'text' },
      ],
    }),
    query({ sorts: [{ field: 'label', direction: 'ascending', order: 'natural' }] }),
    query({ sorts: [{ field: 'date', direction: 'ascending', order: 'date' }] }),
    query({ sorts: [{ field: 'live', direction: 'descending', order: 'boolean' }] }),
    query({ sorts: [{ field: 'tags', direction: 'ascending', order: 'count' }] }),
    query({ sorts: [{ field: 'title', direction: 'ascending', order: 'length' }], offset: 1, limit: 2 }),
    query({ offset: 3 }),
    query({ limit: 1 }),
  ];
  for (const input of cases) {
    assert.deepEqual(queryOrder(ITEMS, input), oracle(input), JSON.stringify({ conditions: input.conditions, sorts: input.sorts }));
  }
});

test('custom code, a random order and a picked selection have no order here', () => {
  assert.equal(queryOrder(ITEMS, query({ random: true })), undefined);
  assert.equal(queryOrder(ITEMS, query({ customSort: '(a, b) => 0' })), undefined);
  assert.equal(queryOrder(ITEMS, query({ conditions: [{ kind: 'custom', code: 'item.x' }] })), undefined);
  assert.equal(queryOrder(ITEMS, query({ sorts: [{ field: 'title', direction: 'ascending', order: 'fileSize' }] })), undefined);
});

const FRONTMATTER = 'const promises = ["Free", "Works", "Easy"];\nconst icons = [check];\n';
const PAGE = `---\n${FRONTMATTER}---\n<ul>\n  {promises.map((promise) => (\n    <li class="item">{promise}</li>\n  ))}\n</ul>\n`;
const CONTEXT = { file: 'src/pages/index.astro', catalog: { templates: [], instances: {} } } as const;

test('a loop head that filters, sorts and limits becomes a reorder of the baked copies', () => {
  assert.deepEqual(loopRun(FRONTMATTER, 'promises.map((promise) => ('), { name: 'promises', item: 'promise', index: '', order: [0, 1, 2] });
  const limited = planPageChange(PAGE, PAGE.replace('promises.map', 'promises.slice(1, 3).map'), CONTEXT);
  assert.deepEqual(limited.notShown, []);
  assert.deepEqual(limited.loops, [{ paths: ['0.0.0'], baked: [0, 1, 2], order: [1, 2] }]);
  const plans = PAGE.replace(
    'const promises = ["Free", "Works", "Easy"];',
    'const promises = [{ name: "Free", rank: 3 }, { name: "Works", rank: 1 }, { name: "Easy", rank: 2 }];',
  ).replace('{promise}', '{promise.name}');
  const sorted = plans.replace('promises.map', 'promises.filter((item) => item.rank > 1).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map');
  const plan = planPageChange(plans, sorted, CONTEXT);
  assert.deepEqual(plan.notShown, []);
  assert.deepEqual(plan.loops, [{ paths: ['0.0.0'], baked: [0, 1, 2], order: [2, 0] }], 'Easy (rank 2), then Free (rank 3)');
  assert.deepEqual(planPageChange(sorted, plans, CONTEXT).notShown, [NOT_SHOWN.dynamic], 'An item the bake never rendered cannot come back without Astro');
});

test('negative space: what a reorder cannot show keeps the refusal', () => {
  const refused = (to: string, name: string) => assert.deepEqual(planPageChange(PAGE, to, CONTEXT).notShown, [NOT_SHOWN.dynamic], name);
  refused(PAGE.replace('promises.map', 'promises.toSorted(() => Math.random() - 0.5).map'), 'A random order');
  refused(PAGE.replace('promises.map((promise)', 'promises.map((promise, i)'), 'An index the body reads');
  refused(PAGE.replace('{promise}</li>', '{promise}!</li>').replace('promises.map', 'promises.slice(0, 1).map'), 'A body edit with the head');
  refused(
    PAGE.replace('promises.map((promise) => (\n    <li class="item">{promise}</li>', 'icons.map((icon) => (\n    <li class="item">{icon}</li>'),
    'A list of names',
  );
});

test('the settings panel opens for a reorderable loop and stays locked inside it', () => {
  assert.equal(settingsLockReason(PAGE, 'n0.0', CONTEXT), undefined, 'The loop itself');
  // Its bound text reads as Desktop draws it, a data chip; a change to it is noted when made.
  assert.equal(settingsLockReason(PAGE, 'n0.0.0', CONTEXT), undefined, 'Its body’s bound text');
  const coded = PAGE.replace('{promise}', '{promise.toUpperCase()}');
  assert.equal(settingsLockReason(coded, 'n0.0.0', CONTEXT), NOT_SHOWN.dynamic, 'Its body, when it is code');
  const names = PAGE.replace('promises.map((promise) => (\n    <li class="item">{promise}</li>', 'icons.map((icon) => (\n    <li class="item">{icon}</li>');
  assert.equal(settingsLockReason(names, 'n0.0', CONTEXT), NOT_SHOWN.dynamic, 'A loop over names');
});

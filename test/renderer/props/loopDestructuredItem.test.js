// Goal: a loop whose item is destructured — `work.map(({ data }) => (`, the
// way an AI-built Astro page loops a content collection — gets the same list
// settings (Source, Filters, Sort, Limit) as one written `(entry) =>`, instead
// of falling back to a lone Code field. Anything the controls cannot model
// still fails safe to custom code, and says why.
//
// Method: pure code, no DOM. First the head parser: each destructured shape
// that must split, then the negative space (nested patterns, defaults, empty
// patterns, statement bodies, non-arrow callbacks) that must stay custom. Then
// the reader over the frontmatter shapes such pages declare (a bare
// `getCollection`, `.sort`, `.filter`, `.slice`, an inline `(await ...)`).
// Then the planner: each edit writes the list where it is written, keeps the
// head's pattern byte for byte, leaves the body alone, never rewrites a
// declaration something else reads, and refuses what needs an item name.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { parseMapHead, customLoopReason } = load('src/features/props/propNodeEditors.tsx');
const { splitDestructuredHead, splitMapHead } = load('src/editor/loopBindings.ts');
const { readLoop } = load('src/editor/loopQueryRead.ts');
const { planLoop } = load('src/editor/loopQueryPlan.ts');
const loopQuery = load('src/editor/loopQuery.ts');

// --- The head ------------------------------------------------------------------

for (const [head, data, index] of [
  ['work.map(({ data }) => (', 'work', ''],
  ['work.map(({data,id,slug}) => (', 'work', ''],
  ['work.map(({ data: entry }, i) => (', 'work', 'i'],
  ['work.map(({ id, ...rest }) => (', 'work', ''],
  ["(await getCollection('work')).map(({ data }) => (", "(await getCollection('work'))", ''],
  ['work.slice(0, 3).map(({ data }) => (', 'work.slice(0, 3)', ''],
]) {
  assert.deepEqual(parseMapHead(head), { data, item: undefined, index }, head);
  assert.equal(splitMapHead(head), undefined, `${head} is not a named item: the rename and rebind code must not see it`);
}
// Named items are unchanged.
assert.deepEqual(parseMapHead('entries.map((entry) => ('), { data: 'entries', item: 'entry', index: '' });

for (const head of [
  'work.map(({ data: { title } }) => (', // nested
  'work.map(({ data = {} }) => (', // default
  'work.map(({}) => (', // declares nothing
  'work.map(({ data }) => {', // statement body
  'work.map(function ({ data }) { return (', // not an arrow
  'work.map(({ data }, index, all) => (', // third parameter
  'work.map(({ data })) => (',
  '',
]) {
  assert.equal(parseMapHead(head), undefined, head);
  assert.equal(splitDestructuredHead(head), undefined, head);
}

assert.equal(customLoopReason({ head: 'work.map(({ data: { title } }) => (' }), 'props.map.why.nestedPattern');
assert.equal(customLoopReason({ head: 'work.map(function (w) { return (' }), 'props.map.why.shape');
assert.equal(customLoopReason({ head: 'work.map((w) => (', bodyParts: ['', ''] }), 'props.map.why.statements');

// --- Reading: the declarations such a page holds -----------------------------------

const imports = [{ name: 'getCollection', path: 'astro:content', imported: 'getCollection' }];
const read = (frontmatter, data) => readLoop({ frontmatter, imports, data });
for (const [frontmatter, data, collection] of [
  ["const work = await getCollection('work');", 'work', 'work'],
  ["const work = (await getCollection('work')).sort((a, b) => a.data.order - b.data.order);", 'work', 'work'],
  ["const work = await getCollection('work', ({ data }) => data.featured);", 'work', 'work'],
  ["const all = await getCollection('work'); const work = all.filter((w) => w.data.featured).slice(0, 3);", 'work', 'work'],
  ["const entries = await getCollection('blog');", 'entries.slice(0, 3)', 'blog'],
  ['', "(await getCollection('team'))", 'team'],
]) {
  const reading = read(frontmatter, data);
  assert.equal(reading.kind, 'query', `${data}: ${JSON.stringify(reading)}`);
  assert.equal(reading.query.source.collection, collection, data);
}
// A step the controls cannot say keeps the collection and the code, with a reason.
const reversed = read("const work = await getCollection('work');", 'work.sort((a, b) => a.data.order - b.data.order).slice(0, 3).reverse()');
assert.equal(reversed.kind, 'partial');
assert.ok(reversed.reason.length > 0);
// Not a collection at all: a list written in the page, never read as a collection.
const literal = read('const work = [1, 2];', 'work');
assert.notEqual(literal.query?.source.kind, 'astro');

// --- Planning ----------------------------------------------------------------------

const children = [{ id: 'title', kind: 'expr', value: 'data.title' }];
const HEAD = 'work.map(({ data, id }) => (';
const modelOf = (extraFrontmatter, extraNodes = []) => ({
  extraFrontmatter,
  imports,
  nodes: [{ id: 'loop', kind: 'map', head: HEAD, children }, ...extraNodes],
});
const plan = (model, target) => planLoop({ model, loop: model.nodes[0], target, sanityClient: 'unavailable' });
const teamQuery = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), limit: 4 };

// A limit on a list the loop alone reads: the declaration is rewritten in place, the head keeps its pattern, the body is the same object.
const own = modelOf("const work = await getCollection('work');");
const limited = plan(own, { kind: 'query', query: { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'work' }), limit: 3 }, fields: [] });
assert.equal(limited.ok, true, JSON.stringify(limited));
assert.ok(limited.plan.extraFrontmatter.includes('.slice(0, 3)'), limited.plan.extraFrontmatter);
assert.ok(limited.plan.loop.head.endsWith('.map(({ data, id }) => ('), limited.plan.loop.head);
assert.equal(limited.plan.loop.children, children, 'the body is not rebound or rewritten');
assert.equal(limited.plan.unbound, 0);

// Another collection: the same, and the body is still untouched.
const toTeam = plan(own, { kind: 'query', query: teamQuery, fields: [] });
assert.equal(toTeam.ok, true);
assert.ok(toTeam.plan.extraFrontmatter.includes("getCollection('team')"));
assert.ok(!toTeam.plan.extraFrontmatter.includes("getCollection('work')"));
assert.ok(toTeam.plan.loop.head.endsWith('.map(({ data, id }) => ('));
assert.equal(toTeam.plan.loop.children, children);

// Shared: something else reads `work`, so its declaration is left exactly as written and the loop is pointed at a new one.
const shared = modelOf("const work = await getCollection('work');", [{ id: 'count', kind: 'expr', value: 'work.length' }]);
const sharedPlan = plan(shared, { kind: 'query', query: teamQuery, fields: [] });
assert.equal(sharedPlan.ok, true);
assert.ok(sharedPlan.plan.extraFrontmatter.startsWith("const work = await getCollection('work');"), 'the shared declaration stays');
assert.ok(sharedPlan.plan.loop.head.endsWith('.map(({ data, id }) => ('));
assert.ok(!sharedPlan.plan.loop.head.startsWith('work.map'), 'the loop reads the new list');

// A sort written as code: only the sort's bytes change, in the declaration.
const sorted = modelOf("const work = (await getCollection('work')).sort((a, b) => a.data.order - b.data.order);");
const resorted = plan(sorted, { kind: 'section', section: 'sort', code: '(a, b) => b.data.order - a.data.order' });
assert.equal(resorted.ok, true, JSON.stringify(resorted));
assert.ok(resorted.plan.extraFrontmatter.includes('b.data.order - a.data.order'));
assert.equal(resorted.plan.loop.head, HEAD, 'a section edit leaves the head as it was');

// A section edit that changes the head's own list keeps the pattern.
const inline = { extraFrontmatter: '', imports, nodes: [{ id: 'loop', kind: 'map', head: "(await getCollection('work')).map(({ data }) => (", children }] };
const inlineLimit = planLoop({ model: inline, loop: inline.nodes[0], target: { kind: 'section', section: 'limit', code: '3' }, sanityClient: 'unavailable' });
assert.equal(inlineLimit.ok, true, JSON.stringify(inlineLimit));
assert.ok(inlineLimit.plan.loop.head.endsWith('.map(({ data }) => ('), inlineLimit.plan.loop.head);
assert.ok(inlineLimit.plan.loop.head.includes('.slice(0, 3)'), inlineLimit.plan.loop.head);

// What needs an item name is refused with a reason, and writes nothing: a List prop's settings go into the head under the item's name.
const refused = plan(own, { kind: 'query', query: loopQuery.emptyQuery({ kind: 'list', collection: 'items' }), fields: [] });
assert.equal(refused.ok, false);
assert.equal(refused.messageRef.key, 'editor.loopPlan.customCode');

// A head the editor cannot split is still refused, as before.
const nested = { ...own, nodes: [{ id: 'loop', kind: 'map', head: 'work.map(({ data: { title } }) => (', children }] };
assert.equal(plan(nested, { kind: 'query', query: teamQuery, fields: [] }).ok, false);

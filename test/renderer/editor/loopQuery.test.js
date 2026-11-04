// A loop's list settings: read from any code that says them, written as code
// that cannot break the page, and placed so nothing is left behind.
//
//   node test/renderer/editor/loopQuery.test.js
//
// The panel shows a collection list's Source, Filters, Sort and Limit for a
// loop however its code was written — by hand, by an AI assistant, or by
// Stacki — so the reader is checked against the many shapes the same list can
// take: a filter callback passed to getCollection or chained with .filter, a
// destructured or named parameter, a block body, .sort or .toSorted with dates
// read four different ways, a GROQ query inline, through defineQuery or a
// constant. What the reader cannot model must come back as custom code kept
// verbatim, never as a guess. Then the writer: every query it accepts must
// produce code that parses and reads back as the same query (a round trip),
// with hostile text in values escaped. Last, the planner: switching sources
// replaces the old query in its slot, removes what only it used, re-points or
// unbinds the loop's children, and never touches anything something else reads.
// Then a visual builder's export, whose settings are data or generated code.
// Last of all, tracing: a list an imported function computes is followed into
// that function's file, to the query and the collection it reads.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { readLoop } = load('src/editor/loopQueryRead.ts');
const loopQuery = load('src/editor/loopQuery.ts');
const { planLoop, childrenFingerprint } = load('src/editor/loopQueryPlan.ts');
const { parseExpression, parseFrontmatter } = load('src/editor/loopSyntax.ts');
const { readGroq } = load('src/editor/groqSyntax.ts');
const { reboundCode, reboundItem } = load('src/editor/loopRebind.ts');

const astroImports = [{ name: 'getCollection', path: 'astro:content' }];
const sanityImports = [
  { name: 'sanityClient', path: 'sanity:client' },
  { name: 'defineQuery', path: 'groq' },
];
const read = (frontmatter, data, imports = astroImports, fieldKind) => readLoop({ frontmatter, imports, data, fieldKind });
const queryOf = (reading) => {
  assert.equal(reading.kind, 'query', JSON.stringify(reading));
  return reading.query;
};

// --- Reading: one list, written many ways --------------------------------------

const featuredDraftless = [
  'const posts = await getCollection("blog", ({ data }) => !data.draft && data.featured === true);',
  'const posts = await getCollection("blog", (entry) => entry.data.draft !== true && entry.data.featured);',
  'const posts = await getCollection("blog", function (post) { return !post.data.draft && true === post.data.featured; });',
  'const posts = (await getCollection("blog")).filter((p) => !p.data.draft).filter((p) => p.data.featured === true);',
];
for (const code of featuredDraftless) {
  const query = queryOf(read(code, 'posts'));
  assert.equal(query.source.collection, 'blog', code);
  assert.deepEqual(
    query.conditions.map((condition) => `${condition.field}:${condition.operator}`),
    ['draft:isFalse', 'featured:isTrue'],
    code,
  );
}

const newestFirst = [
  '(a, b) => b.data.date.valueOf() - a.data.date.valueOf()',
  '(a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()',
  '(a, b) => +b.data.date - +a.data.date',
  '(a, b) => Date.parse(b.data.date) - Date.parse(a.data.date)',
];
for (const comparator of newestFirst) {
  for (const method of ['sort', 'toSorted']) {
    const query = queryOf(read(`const posts = (await getCollection('blog')).${method}(${comparator});`, 'posts.slice(0, 3)', astroImports, () => 'date'));
    assert.deepEqual(query.sorts, [{ field: 'date', direction: 'descending', order: 'date' }], comparator);
    assert.equal(query.limit, 3);
  }
}
assert.deepEqual(queryOf(read("const p = (await getCollection('blog')).sort((x, y) => x.data.title.localeCompare(y.data.title)).reverse();", 'p')).sorts, [
  { field: 'title', direction: 'descending', order: 'text' },
]);
assert.equal(queryOf(read("const p = (await getCollection('blog')).sort(() => Math.random() - 0.5);", 'p')).random, true);
assert.deepEqual(queryOf(read('', "(await getCollection('blog')).slice(2, 5)")).offset, 2);

// An aliased import is still astro:content's getCollection.
assert.equal(
  queryOf(read("const p = await load('team');", 'p', [{ name: 'load', imported: 'getCollection', path: 'astro:content' }])).source.collection,
  'team',
);

// A clause the settings cannot show is kept as written, around the ones they can.
const envDrafts = queryOf(read("const p = await getCollection('blog', ({ data }) => (import.meta.env.PROD ? !data.draft : true) && data.n > 2);", 'p'));
assert.equal(envDrafts.conditions[0].kind, 'custom');
assert.equal(envDrafts.conditions[0].code, 'import.meta.env.PROD ? !data.draft : true');
assert.deepEqual(envDrafts.conditions[1], { kind: 'test', field: 'n', operator: 'greater', value: 2 });

// Truthiness means "is on" only for a switch; on text it is code.
const kinds = (kind) => () => kind;
assert.equal(queryOf(read("const p = await getCollection('b', ({ data }) => data.image);", 'p', astroImports, kinds('image'))).conditions[0].kind, 'custom');
assert.equal(queryOf(read("const p = await getCollection('b', ({ data }) => data.on);", 'p', astroImports, kinds('boolean'))).conditions[0].operator, 'isTrue');

// Steps that change what an item is, or run in an order the settings cannot
// say, leave the source known and the rest as code.
for (const code of [
  "const p = (await getCollection('blog')).map((post) => post.data);",
  "const p = (await getCollection('blog')).slice(0, 3).filter((post) => post.data.on);",
  "const p = (await getCollection('blog')).reverse();",
]) {
  const reading = read(code, 'p');
  assert.equal(reading.kind, 'partial', code);
  assert.equal(reading.source.collection, 'blog');
}

// Values from anywhere else are named for where they come from.
assert.deepEqual(read('const pastors = await getCampusPastors();', 'pastors', [{ name: 'getCampusPastors', path: '@/sanity/queries' }]).origin, {
  kind: 'call',
  exportName: 'getCampusPastors',
  spec: '@/sanity/queries',
});
assert.equal(read('', 'Astro.props.items').kind, 'value');
assert.equal(read('', 'post.data.tags').kind, 'value');
assert.equal(read('', '[]').kind, 'empty');
assert.equal(read('', 'items.map((').kind, 'code');
// A cycle of declarations ends rather than looping.
assert.equal(read('const a = b;\nconst b = a;', 'a').kind, 'value');

// --- Reading GROQ ---------------------------------------------------------------

const groqForms = [
  'const q = await sanityClient.fetch(`*[_type == "pastor" && featured == true] | order(name asc) [0...6]`);',
  'const q = await sanityClient.fetch(\'*[_type == "pastor" && featured == true] | order(name asc) [0..5]\');',
  'const Q = defineQuery(`*[_type == "pastor" && featured == true] | order(name asc) [0...6]`);\nconst q = await sanityClient.fetch(Q);',
];
for (const code of groqForms) {
  const query = queryOf(read(code, 'q', sanityImports));
  assert.equal(query.source.kind, 'sanity', code);
  assert.equal(query.source.collection, 'pastor');
  assert.deepEqual(query.conditions, [{ kind: 'test', field: 'featured', operator: 'isTrue' }]);
  assert.deepEqual(
    query.sorts.map((sort) => sort.field),
    ['name'],
  );
  assert.equal(query.limit, 6);
}
const projected = readGroq(
  '*[_type == "post" && !(_id in path("drafts.**")) && (category._ref == "news" || "x" in tags)] { title, "image": image.asset->url }',
);
assert.equal(projected.projection, '{ title, "image": image.asset->url }');
assert.equal(projected.conditions[0].kind, 'custom');
assert.equal(readGroq('*[_type == "a" && (x == 1 || y == 2)]').match, 'any');
assert.equal(readGroq('*[_type == "post" && slug.current == $slug][0]'), undefined, 'parameters stay custom');
assert.equal(readGroq('*[_type == "a"] { x } | order(x asc)'), undefined, 'a projection before order is code');
assert.equal(readGroq('*[_type == "a" || _type == "b"]'), undefined, 'two types is not one collection');

// --- Writing: every written query reads back as itself ----------------------------

const hostile = 'it\'s "quoted" \\ back`slash ${x}\n ';
const astroQuery = {
  ...loopQuery.emptyQuery({ kind: 'astro', collection: 'case-studies' }),
  conditions: [
    { kind: 'test', field: 'title', operator: 'is', value: { kind: 'text', text: hostile } },
    { kind: 'test', field: 'category', operator: 'is', value: { kind: 'reference', id: 'get-involved' } },
    { kind: 'test', field: 'tags', operator: 'has', value: { kind: 'reference', id: 'news' } },
    { kind: 'test', field: 'summary', operator: 'contains', value: 'Grace' },
    { kind: 'test', field: 'rank', operator: 'atLeast', value: -2.5 },
    { kind: 'test', field: 'date', operator: 'before', value: '2025-01-01' },
    { kind: 'test', field: 'date', operator: 'inPast' },
    { kind: 'test', field: 'image', operator: 'isSet' },
    { kind: 'test', field: 'campus-name', operator: 'isEmpty' },
    { kind: 'test', field: 'live', operator: 'isFalse' },
  ],
  sorts: [
    { field: 'live', direction: 'descending', order: 'boolean' },
    { field: 'date', direction: 'descending', order: 'date' },
    { field: 'title', direction: 'ascending', order: 'text' },
  ],
  offset: 2,
  limit: 4,
};
const astroCode = loopQuery.astroQueryCode(astroQuery);
assert.ok(parseExpression(astroCode), astroCode);
const fieldKinds = { category: 'reference', tags: 'list', image: 'image', live: 'boolean', date: 'date', rank: 'number' };
const astroBack = queryOf(read(`const x = ${astroCode};`, 'x', astroImports, (_source, path) => fieldKinds[path] ?? 'text'));
assert.deepEqual(
  astroBack.conditions,
  astroQuery.conditions.map((condition) => (condition.operator === 'contains' ? { ...condition, value: 'grace' } : condition)),
);
assert.deepEqual(astroBack.sorts, astroQuery.sorts);
assert.equal(astroBack.offset, 2);
assert.equal(astroBack.limit, 4);
assert.ok(astroCode.includes('(data.category?.id ?? data.category)'), 'a choice or reference compares by id');
assert.ok(astroCode.includes("data['campus-name']"), 'a field name that is not an identifier is indexed');
// A switch sorts off (false or unset) before on; descending puts the on ones first.
assert.ok(astroCode.includes('Number(b.data.live === true) - Number(a.data.live === true)'), astroCode);
const switchFirst = new Function('a', 'b', 'return Number(b.live === true) - Number(a.live === true);');
assert.deepEqual(
  [{ live: false }, { live: true }, {}].sort(switchFirst).map((item) => item.live),
  [true, false, undefined],
  'Is On First puts on first and keeps unset with off',
);

const sanityQuery = {
  ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'sermon' }),
  match: 'any',
  conditions: [
    { kind: 'test', field: 'speaker', operator: 'is', value: { kind: 'reference', id: 'abc-123' } },
    { kind: 'test', field: 'title', operator: 'contains', value: hostile },
    { kind: 'test', field: 'slug.current', operator: 'isNot', value: { kind: 'text', text: 'home' } },
    { kind: 'custom', code: '!(_id in path("drafts.**"))' },
  ],
  sorts: [{ field: '_createdAt', direction: 'descending', order: 'date' }],
  limit: 10,
};
const fields = [
  { path: 'image', title: 'Image', kind: 'image', options: [] },
  { path: 'speaker', title: 'Speaker', kind: 'reference', options: [] },
];
const sanityCode = loopQuery.sanityQueryCode(sanityQuery, fields, 'sanityClient');
assert.ok(parseExpression(sanityCode), sanityCode);
const sanityBack = queryOf(read(`const x = ${sanityCode};`, 'x', sanityImports));
assert.deepEqual(sanityBack.conditions, sanityQuery.conditions);
assert.equal(sanityBack.match, 'any');
assert.equal(sanityBack.projection, '{ ..., "image": image.asset->url, "speaker": speaker-> }');
// A shuffle happens in JS, after a fetch of every match.
const shuffled = loopQuery.sanityQueryCode({ ...sanityQuery, random: true }, [], 'sanityClient');
assert.match(shuffled, /\.sort\(\(\) => Math\.random\(\) - 0\.5\)\.slice\(0, 10\)$/);
assert.equal(queryOf(read(`const x = ${shuffled};`, 'x', sanityImports)).random, true);

// The writer refuses what it could not write safely: a programmer error.
assert.throws(() => loopQuery.astroQueryCode({ ...astroQuery, limit: 0 }), /A limit shows at least one item/);
assert.throws(() => loopQuery.astroQueryCode({ ...astroQuery, conditions: [{ kind: 'test', field: 'a b', operator: 'isSet' }] }), /field path segment/);
assert.throws(() => loopQuery.astroQueryCode({ ...astroQuery, conditions: [{ kind: 'test', field: 'd', operator: 'before', value: 'soon' }] }), /YYYY-MM-DD/);
assert.throws(() => loopQuery.astroQueryCode({ ...astroQuery, source: { kind: 'astro', collection: "x'); evil(" } }), /names a collection/);

// --- Planning: one change, nothing left behind -------------------------------------

const loop = (head, children = []) => ({ id: 'loop', kind: 'map', head, children });
const pastorChildren = [
  {
    id: 'img',
    kind: 'element',
    name: 'img',
    props: { src: { type: 'expr', value: 'pastor.image' }, alt: { type: 'expr', value: 'pastor.name' } },
    children: [],
  },
  { id: 'role', kind: 'expr', value: 'pastor.role' },
  { id: 'if', kind: 'cond', test: 'pastor.featured', children: [] },
];
const handWritten = {
  extraFrontmatter: 'const title = "Home";\nconst campusPastors = await getCampusPastors();\nconst other = 1;',
  imports: [{ name: 'getCampusPastors', imported: 'getCampusPastors', path: '@/sanity/queries.ts', quote: '"', named: true }],
  nodes: [loop('campusPastors.map((pastor) => (', pastorChildren)],
};
const teamFields = [
  { path: 'name', title: 'Name', kind: 'text', options: [] },
  { path: 'image', title: 'Image', kind: 'image', options: [] },
];
const toTeam = planLoop({
  model: handWritten,
  loop: handWritten.nodes[0],
  target: { kind: 'query', query: { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), limit: 4 }, fields: teamFields },
  sanityClient: 'unavailable',
});
assert.equal(toTeam.ok, true);
assert.equal(
  toTeam.plan.extraFrontmatter,
  'const title = "Home";\nconst teamEntries = (await getCollection(\'team\')).slice(0, 4); // stacki:query\nconst other = 1;',
  'the query takes the slot of the one it replaces',
);
assert.deepEqual(
  toTeam.plan.imports.map((entry) => entry.name),
  ['getCollection'],
  'the import only the old source used is gone',
);
assert.equal(toTeam.plan.loop.head, 'teamEntries.map((pastor) => (');
assert.equal(toTeam.plan.loop.children[0].props.src.value, 'pastor.data.image');
assert.equal(toTeam.plan.loop.children[1].kind, 'text', 'a field the new collection lacks is unbound, not left to throw');
assert.equal(toTeam.plan.loop.children[2].test, 'false');
assert.equal(toTeam.plan.unbound, 2);

// Back to nothing: the file is as it was before any query.
const after = { ...handWritten, extraFrontmatter: toTeam.plan.extraFrontmatter, imports: toTeam.plan.imports, nodes: [toTeam.plan.loop] };
const cleared = planLoop({ model: after, loop: toTeam.plan.loop, target: { kind: 'empty' }, sanityClient: 'available' });
assert.equal(cleared.plan.extraFrontmatter, 'const title = "Home";\nconst other = 1;');
assert.deepEqual(cleared.plan.imports, []);
assert.equal(cleared.plan.loop.head, '[].map((pastor) => (');

// Read by something else, the old source stays, and the new one is added.
const shared = { ...handWritten, nodes: [...handWritten.nodes, { id: 'count', kind: 'expr', value: 'campusPastors.length' }] };
const kept = planLoop({
  model: shared,
  loop: shared.nodes[0],
  target: { kind: 'query', query: loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), fields: teamFields },
  sanityClient: 'unavailable',
});
assert.ok(kept.plan.extraFrontmatter.includes('const campusPastors = await getCampusPastors();'));
assert.ok(kept.plan.extraFrontmatter.endsWith("const teamEntries = await getCollection('team'); // stacki:query"));
assert.ok(kept.plan.imports.some((entry) => entry.name === 'getCampusPastors'));

// A GROQ constant the old query fetched goes with it; an export never does.
const groqPage = {
  extraFrontmatter: 'const Q = defineQuery(`*[_type == "pastor"]`);\nconst pastors = await sanityClient.fetch(Q);\nexport const prerender = true;',
  imports: [...sanityImports.map((entry) => ({ ...entry, quote: "'", named: true }))],
  nodes: [loop('pastors.map((pastor) => (')],
};
const narrowed = planLoop({
  model: groqPage,
  loop: groqPage.nodes[0],
  target: { kind: 'query', query: { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }), limit: 3 }, fields: [] },
  sanityClient: 'available',
});
assert.equal(
  narrowed.plan.extraFrontmatter,
  'const pastors = await sanityClient.fetch(\'*[_type == "pastor"] [0...3]\'); // stacki:query\nexport const prerender = true;',
);
assert.deepEqual(
  narrowed.plan.imports.map((entry) => entry.name),
  ['sanityClient'],
);

// Sanity without its integration is refused with a reason, before any edit.
const refused = planLoop({
  model: handWritten,
  loop: handWritten.nodes[0],
  target: { kind: 'query', query: loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }), fields: [] },
  sanityClient: 'unavailable',
});
assert.equal(refused.ok, false);
assert.match(refused.message, /@sanity\/astro/);

// A hand-written loop head is not planned over.
assert.equal(planLoop({ model: handWritten, loop: loop('items.flatMap(({ a }) => ('), target: { kind: 'empty' }, sanityClient: 'available' }).ok, false);

// --- Rebinding ---------------------------------------------------------------------

const toSanity = { kind: 'sanity', fields: new Set(['title', 'author']) };
assert.equal(reboundCode('item.data.title + item.data.author?.name', 'item', toSanity), 'item.title + item.author.name');
assert.equal(reboundCode('item._id', 'item', toSanity), 'item._id');
assert.equal(reboundCode('item.data.body', 'item', toSanity), undefined);
assert.equal(reboundCode('items.length + other.item', 'item', toSanity), 'items.length + other.item', 'only the item itself is re-pointed');
const toAstro = { kind: 'astro', fields: new Set(['title']) };
assert.equal(reboundCode('item.title', 'item', toAstro), 'item.data.title');
assert.equal(reboundCode('item.id', 'item', toAstro), 'item.id');

// An attribute dropped from a node drops its source spans with it: a node whose
// spans name an attribute its props no longer have is refused when saved
// ("attrSpans: names differ from props").
const spanned = {
  id: 'a',
  kind: 'element',
  name: 'a',
  props: { href: { type: 'expr', value: 'item.data.url' }, title: { type: 'expr', value: 'item.data.title' }, class: { type: 'string', value: 'x' } },
  attrOrder: ['class', 'href', 'title'],
  attrSpans: [{ type: 'expr', name: 'href', span: [0, 1], nameSpan: [0, 1], valueSpan: [0, 1] }],
  children: [],
};
const respanned = reboundItem([spanned], 'item', { kind: 'sanity', fields: new Set(['title']) });
assert.equal(respanned.nodes[0].attrSpans, undefined);
assert.deepEqual(respanned.nodes[0].attrOrder, ['class', 'title']);
assert.deepEqual(Object.keys(respanned.nodes[0].props), ['title', 'class']);
assert.deepEqual(respanned.lost, ['url']);
// A node no binding in changed keeps its spans: nothing about its bytes moved.
const untouched = { ...spanned, props: { class: { type: 'string', value: 'x' } }, attrOrder: ['class'] };
assert.deepEqual(reboundItem([untouched], 'item', { kind: 'sanity', fields: new Set() }).nodes[0].attrSpans, untouched.attrSpans);

// Switching back relinks: the children kept for the old source come back.
const original = handWritten.nodes[0];
const back = planLoop({
  model: after,
  loop: toTeam.plan.loop,
  target: { kind: 'value', data: 'campusPastors' },
  sanityClient: 'available',
  restore: original.children,
});
assert.equal(back.plan.restored, true);
assert.equal(back.plan.loop.children[1].kind, 'expr');
assert.equal(back.plan.loop.children[1].value, 'pastor.role');
assert.equal(toTeam.plan.previous, 'value:campusPastors');
// Restoring to what is read now is no switch, and restores nothing.
assert.equal(
  planLoop({ model: handWritten, loop: original, target: { kind: 'value', data: 'campusPastors' }, sanityClient: 'available', restore: [] }).plan.restored,
  false,
);
// Ids and positions a re-parse renews do not count as a change.
assert.equal(childrenFingerprint([{ ...spanned, id: 'z', start: 4 }]), childrenFingerprint([spanned]));
assert.notEqual(childrenFingerprint([{ ...spanned, name: 'b' }]), childrenFingerprint([spanned]));

// --- Syntax ------------------------------------------------------------------------

const declarations = parseFrontmatter('const a = 1, b = 2;\nexport const c = 3; // note\nconst { d } = e;\n').declarations;
assert.equal(declarations.get('a').alone, false);
assert.equal(declarations.get('c').statement.to, 'const a = 1, b = 2;\nexport const c = 3; // note\n'.length);
assert.equal(declarations.has('d'), false);
assert.equal(parseExpression('a; b'), undefined);
assert.equal(parseExpression('x'.repeat(300_000)), undefined);

console.log('loopQuery: ok');

// --- Tracing a list through other files ----------------------------------------------
// `campusPastors = await getCampusPastors()` names what the page does with the
// list; the trace says what it is: a function in another file, the GROQ query
// it fetches, and the Sanity type that query reads, with its filters.
const { traceFunction, rewrittenGroqLiteral } = load('src/editor/loopTrace.ts');
const queriesFile = `import { sanityClient } from "sanity:client";
import { defineQuery } from "groq";
import { getTeam } from "./team";
function fetchOnce(query: string): Promise<any> { return sanityClient.fetch(query); }
const CAMPUS_PASTORS_QUERY = defineQuery(\`*[_type == "campus" && defined(pastorName) && canSetAsMyCampus == true] | order(orderRank asc){ name }\`);
export async function getCampusPastors(): Promise<CampusPastor[]> {
  const campuses = await fetchOnce(CAMPUS_PASTORS_QUERY);
  return (campuses ?? []).map((c: any) => ({ campus: c.name }));
}
export const getLeaders = async () => (await getTeam()).filter((person) => person.lead);
`;
const pastors = traceFunction(queriesFile, 'src/sanity/queries.ts', 'getCampusPastors');
assert.deepEqual(
  pastors.steps.map((step) => step.kind),
  ['function', 'query', 'collection'],
);
assert.equal(pastors.steps[1].name, 'CAMPUS_PASTORS_QUERY');
assert.deepEqual(pastors.steps[2].source, { kind: 'sanity', collection: 'campus' });
assert.deepEqual(
  pastors.steps[2].groq.conditions.map((condition) => condition.operator),
  ['isSet', 'isTrue'],
);
assert.deepEqual(pastors.reshaped, ['map']);
assert.equal(pastors.next, undefined);
// A function whose data comes from another module hands on to that import.
const leaders = traceFunction(queriesFile, 'src/sanity/queries.ts', 'getLeaders');
assert.deepEqual(leaders.next, { name: 'getTeam', spec: './team' });
assert.deepEqual(leaders.reshaped, ['filter']);
// getCollection in another file is an Astro collection.
const astroFile = "import { getCollection as all } from 'astro:content';\nexport function posts() { return all('blog'); }";
assert.deepEqual(traceFunction(astroFile, 'src/lib/posts.ts', 'posts').steps[1].source, { kind: 'astro', collection: 'blog' });
// A name the file does not define traces to itself and stops.
assert.deepEqual(traceFunction(astroFile, 'src/lib/posts.ts', 'missing').steps, [{ kind: 'function', name: 'missing', file: 'src/lib/posts.ts' }]);

// Editing a traced query rewrites only its string literal, in its own quotes,
// and keeps the projection; a file changed since the trace is left alone.
const literal = pastors.steps[2].literal;
assert.equal(queriesFile.slice(literal.from, literal.to).startsWith('`*[_type == "campus"'), true);
const narrowedQuery = {
  ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }),
  conditions: [...pastors.steps[2].groq.conditions, { kind: 'test', field: 'name', operator: 'is', value: { kind: 'text', text: 'a`b${c}' } }],
  projection: pastors.steps[2].groq.projection,
  limit: 3,
};
const rewritten = rewrittenGroqLiteral(queriesFile, literal, loopQuery.groqQueryText(narrowedQuery, []));
assert.ok(rewritten.startsWith(queriesFile.slice(0, literal.from)));
assert.ok(rewritten.endsWith(queriesFile.slice(literal.to)));
const reread = traceFunction(rewritten, 'src/sanity/queries.ts', 'getCampusPastors').steps[2];
assert.deepEqual(reread.groq.conditions, narrowedQuery.conditions);
assert.equal(reread.groq.limit, 3);
assert.equal(reread.groq.projection, '{ name }');
assert.equal(rewrittenGroqLiteral(queriesFile.replace('pastorName', 'pastorTitle'), literal, '*[_type == "x"]'), undefined);

console.log('loopTrace: ok');

// --- A visual builder's export ---------------------------------------------------------
// Exported collection lists keep their items as `{ id, fields }` and their
// settings either as an options object a helper applies, or as generated
// filter and sort code. Both are read as list settings and edited where they
// are, over the same item shape, so no binding inside the loop changes.
const exportImports = [
  { name: 'getCollection', path: 'astro:content' },
  { name: 'queryItems', path: '@/lib/collection-query' },
];
const collectionsCode =
  'const collections = {\n  "nav-links": (await getCollection("nav-links")).filter(entry => !entry.data.isDraft).map(entry => ({id: entry.data._id ?? entry.id, fields: { ...entry.data, slug: entry.id }}))\n};\n';
const generated =
  collectionsCode +
  'const items1 = [...collections["nav-links"]].filter(entry => { const value0 = entry.fields?.["category"]; let expected0 = "Care"; if (typeof value0 === \'boolean\') expected0 = expected0 === \'true\'; return (value0 === expected0); }).sort((a, b) => { const x = a.fields["sort-order"], y = b.fields["sort-order"]; return (x === y ? 0 : x == null ? -1 : String(x).localeCompare(String(y))) * -1; });';
const generatedQuery = queryOf(readLoop({ frontmatter: generated, imports: exportImports, data: 'items1', fieldKind: () => 'text' }));
assert.equal(generatedQuery.source.collection, 'nav-links');
assert.deepEqual(generatedQuery.conditions, [{ kind: 'test', field: 'category', operator: 'is', value: { kind: 'text', text: 'Care' } }]);
assert.deepEqual(generatedQuery.sorts, [{ field: 'sort-order', direction: 'descending', order: 'text' }]);
const exportLoop = loop('items1.map((item0) => (', [{ id: 'name', kind: 'expr', value: 'item0.fields.name' }]);
const generatedPlan = planLoop({
  model: { extraFrontmatter: generated, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...generatedQuery, limit: 4 }, fields: [] },
  sanityClient: 'unavailable',
});
assert.ok(generatedPlan.plan.extraFrontmatter.startsWith(collectionsCode), 'the list it reads is kept as written');
assert.match(
  generatedPlan.plan.extraFrontmatter,
  /const items1 = \[\.\.\.collections\["nav-links"\]\]\.filter\(\(entry\) => entry\.fields\.category === 'Care'\)/,
);
assert.equal(generatedPlan.plan.loop, exportLoop, 'the loop and its bindings are untouched');
assert.equal(queryOf(readLoop({ frontmatter: generatedPlan.plan.extraFrontmatter, imports: exportImports, data: 'items1', fieldKind: () => 'text' })).limit, 4);
// An unfiltered list is a collection too, with nothing set.
assert.equal(
  readLoop({ frontmatter: collectionsCode + 'const items1 = [...collections["nav-links"]];', imports: exportImports, data: 'items1' }).home.kind,
  'chain',
);
// "0 days in the past" is the build date.
const relative = generated.replace('let expected0 = "Care"', 'let expected0 = "0 days in the past"').replace('(value0 === expected0)', '(value0 >= expected0)');
assert.equal(queryOf(readLoop({ frontmatter: relative, imports: exportImports, data: 'items1', fieldKind: () => 'date' })).conditions[0].operator, 'inFuture');

const optionsCode =
  collectionsCode.replaceAll('nav-links', 'campus') +
  'const { filters: propFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "featured", "operatorName": "eq", "value": "true"}]} } = Astro.props;\n' +
  'const items1 = queryItems(collections["campus"] || [], ({"usePrimaryLocale": false, "sort": [{"field": "name", "direction": "desc"}], "filter": propFilters, "limit": 6}), {});';
const optionsReading = readLoop({
  frontmatter: optionsCode,
  imports: exportImports,
  data: 'items1',
  fieldKind: (_source, field) => (field === 'featured' ? 'boolean' : 'text'),
});
assert.equal(optionsReading.home.kind, 'options');
assert.equal(optionsReading.home.settings.filter.kind, 'prop');
assert.equal(optionsReading.home.settings.filter.key, 'filters');
assert.equal(optionsReading.home.settings.sort.kind, 'inline');
assert.equal(optionsReading.home.settings.offset.kind, 'none');
assert.deepEqual(optionsReading.query.conditions, [{ kind: 'test', field: 'featured', operator: 'isTrue' }]);
assert.deepEqual(optionsReading.query.sorts, [{ field: 'name', direction: 'descending', order: 'text' }]);
assert.equal(optionsReading.query.limit, 6);
const optionsPlan = planLoop({
  model: { extraFrontmatter: optionsCode, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: {
    kind: 'query',
    query: { ...optionsReading.query, conditions: [{ kind: 'test', field: 'name', operator: 'contains', value: 'Prairie' }], limit: undefined, offset: 1 },
    fields: [],
  },
  sanityClient: 'unavailable',
});
const written = optionsPlan.plan.extraFrontmatter;
assert.ok(
  written.includes('filters: propFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "name", "operatorName": "contains", "value": "Prairie"}]}'),
  'filters go to the prop default',
);
assert.ok(
  written.includes('({"usePrimaryLocale": false, "sort": [{"field": "name", "direction": "desc"}], "filter": propFilters, "limit": 0, "offset": 1})'),
  'other keys are kept',
);
const optionsBack = readLoop({ frontmatter: written, imports: exportImports, data: 'items1' }).query;
assert.equal(optionsBack.offset, 1);
assert.equal(optionsBack.limit, undefined);
// What the data cannot say is refused, not written.
assert.equal(
  planLoop({
    model: { extraFrontmatter: optionsCode, imports: exportImports, nodes: [exportLoop] },
    loop: exportLoop,
    target: { kind: 'query', query: { ...optionsReading.query, random: true }, fields: [] },
    sanityClient: 'unavailable',
  }).ok,
  false,
);
// Linking settings to component props. Binding moves a setting's value into a
// new prop's default, so the component renders as before; the setting then
// reads from and writes to that default, and unlinking puts it back inline.
const bindPlan = (frontmatter, change) =>
  planLoop({
    model: { extraFrontmatter: frontmatter, imports: exportImports, nodes: [exportLoop] },
    loop: exportLoop,
    target: { kind: 'binding', change },
    sanityClient: 'unavailable',
  });
const sortBound = bindPlan(optionsCode, { kind: 'bind', setting: 'sort', key: 'sort' });
assert.equal(sortBound.ok, true, JSON.stringify(sortBound));
const sortCode = sortBound.plan.extraFrontmatter;
assert.ok(sortCode.includes('sort: propSort = [{"field": "name", "direction": "desc"}]'), sortCode);
assert.ok(sortCode.includes('"sort": propSort'), sortCode);
assert.equal(sortBound.plan.loop, exportLoop, 'linking leaves the loop and its children as they were');
const sortReading = readLoop({ frontmatter: sortCode, imports: exportImports, data: 'items1' });
assert.equal(sortReading.home.settings.sort.kind, 'prop');
assert.equal(sortReading.home.settings.sort.key, 'sort');
assert.deepEqual(sortReading.query.sorts, optionsReading.query.sorts, 'a bound setting reads the same');
// Editing a bound setting writes the prop's default, not the options.
const sortEdited = planLoop({
  model: { extraFrontmatter: sortCode, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...sortReading.query, sorts: [{ field: 'name', direction: 'ascending', order: 'text' }] }, fields: [] },
  sanityClient: 'unavailable',
}).plan.extraFrontmatter;
assert.ok(sortEdited.includes('sort: propSort = [{"field": "name", "direction": "asc"}]'), sortEdited);
assert.ok(sortEdited.includes('"sort": propSort'), sortEdited);
// A new property can carry its own tooltip and default, set in its dialog
// before it is created; a tooltip can't end its doc comment early.
const described = bindPlan(optionsCode, {
  kind: 'bind',
  setting: 'sort',
  key: 'order',
  description: 'How the */ list is\nordered',
  defaultCode: '[{"field": "name", "direction": "asc"}]',
}).plan.extraFrontmatter;
assert.ok(described.includes('order: propOrder = [{"field": "name", "direction": "asc"}]'), described);
assert.match(bindPlan(optionsCode, { kind: 'bind', setting: 'sort', key: 'order', defaultCode: '[{' }).message, /not a value/);
const describedProps = 'interface Props {\n  title?: string;\n}\n' + optionsCode;
const withTooltip = bindPlan(describedProps, { kind: 'bind', setting: 'sort', key: 'order', description: 'How the */ list is\nordered' }).plan.extraFrontmatter;
assert.ok(withTooltip.includes('  /** How the * / list is ordered */\n  order?: { field: string; direction: "asc" | "desc" }[];'), withTooltip);
// Selected items link like any other setting. A linked selection with nothing
// picked yet stays a selection, so the list doesn't switch itself back to
// Dynamic; picking writes the property's default.
const pickedBound = bindPlan(optionsCode, { kind: 'bind', setting: 'curated', key: 'items' }).plan.extraFrontmatter;
assert.ok(pickedBound.includes('items: propItems = {"itemIds": []}'), pickedBound);
assert.ok(pickedBound.includes('"curated": propItems'), pickedBound);
const pickedReading = readLoop({ frontmatter: pickedBound, imports: exportImports, data: 'items1' });
assert.equal(pickedReading.home.settings.curated.kind, 'prop');
assert.deepEqual(pickedReading.query.selection, [], 'linked with nothing picked is still a selection');
const picked = planLoop({
  model: { extraFrontmatter: pickedBound, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...pickedReading.query, selection: ['a', 'b'] }, fields: [] },
  sanityClient: 'unavailable',
}).plan.extraFrontmatter;
assert.ok(picked.includes('items: propItems = {"itemIds": ["a","b"]}'), picked);
assert.deepEqual(readLoop({ frontmatter: picked, imports: exportImports, data: 'items1' }).query.selection, ['a', 'b']);
const { readCuratedValue } = load('src/editor/optionsQuery.ts');
assert.deepEqual(readCuratedValue('{"itemIds": ["x"]}'), ['x']);
assert.deepEqual(readCuratedValue('{"itemIds": []}'), []);
assert.equal(readCuratedValue('items'), undefined);
// A setting not written yet is bound with the helper's own default, and added to the options.
const skipBound = bindPlan(sortCode, { kind: 'bind', setting: 'offset', key: 'skip' });
assert.ok(skipBound.plan.extraFrontmatter.includes('skip: propSkip = 0'), skipBound.plan.extraFrontmatter);
assert.ok(skipBound.plan.extraFrontmatter.includes('"offset": propSkip})'), skipBound.plan.extraFrontmatter);
assert.equal(readLoop({ frontmatter: skipBound.plan.extraFrontmatter, imports: exportImports, data: 'items1' }).home.settings.offset.kind, 'prop');
// A component with no props yet gets a destructure above the list.
const noProps = collectionsCode.replaceAll('nav-links', 'campus') + 'const items1 = queryItems(collections["campus"] || [], ({"limit": 6}), {});';
const limitBound = bindPlan(noProps, { kind: 'bind', setting: 'limit', key: 'limit' }).plan.extraFrontmatter;
assert.ok(limitBound.includes('const { limit: propLimit = 6 } = Astro.props;\nconst items1 = queryItems('), limitBound);
assert.equal(readLoop({ frontmatter: limitBound, imports: exportImports, data: 'items1' }).query.limit, 6);
// Unlinking puts the default back where the options name the prop.
const unlinked = bindPlan(sortCode, { kind: 'unbind', setting: 'sort' }).plan.extraFrontmatter;
assert.ok(unlinked.includes('"sort": [{"field": "name", "direction": "desc"}]'), unlinked);
assert.equal(readLoop({ frontmatter: unlinked, imports: exportImports, data: 'items1' }).home.settings.sort.kind, 'inline');
// What cannot be done is said, not written.
assert.match(bindPlan(optionsCode, { kind: 'bind', setting: 'sort', key: 'filters' }).message, /already has a filters property/);
assert.match(bindPlan(optionsCode, { kind: 'bind', setting: 'sort', key: '2fast' }).message, /starting with a letter/);
// A linked setting moved to a new property keeps its value: the new
// property's default is the old one's.
const moved = bindPlan(optionsCode, { kind: 'bind', setting: 'filter', key: 'campusFilters' }).plan.extraFrontmatter;
assert.ok(moved.includes('campusFilters: propCampusFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "featured"'), moved);
assert.ok(moved.includes('"filter": propCampusFilters'), moved);
// Connecting to a property the component has: only one whose default this
// setting could read is offered, and its default becomes the value.
const { connectableProps } = load('src/editor/optionsBinding.ts');
const twoFilters = moved;
assert.deepEqual(connectableProps(twoFilters, 'filter'), ['filters', 'campusFilters']);
assert.deepEqual(connectableProps(twoFilters, 'sort'), []);
assert.deepEqual(connectableProps(skipBound.plan.extraFrontmatter, 'offset'), ['skip']);
const connected = bindPlan(twoFilters, { kind: 'connect', setting: 'filter', key: 'filters' }).plan.extraFrontmatter;
assert.ok(connected.includes('"filter": propFilters'), connected);
assert.equal(readLoop({ frontmatter: connected, imports: exportImports, data: 'items1' }).home.settings.filter.key, 'filters');
assert.match(bindPlan(twoFilters, { kind: 'connect', setting: 'sort', key: 'filters' }).message, /can’t hold this list’s sort/);
// A property's tooltip is its doc comment in `interface Props`.
const { propTooltip } = load('src/editor/loopProps.ts');
assert.equal(
  propTooltip('interface Props {\n  /** Filters\n   * for the list */\n  filters?: unknown;\n  bare?: number;\n}', 'filters'),
  'Filters\nfor the list',
);
assert.equal(
  propTooltip('interface Props {\n  /** Filters */\n  filters?: unknown;\n  bare?: number;\n}', 'bare'),
  '',
  'a comment belongs to the member under it',
);
assert.match(bindPlan(optionsCode, { kind: 'unbind', setting: 'sort' }).message, /not linked/);
// A local name the frontmatter already binds is not reused.
const clash = bindPlan('const propSort = 1;\n' + optionsCode, { kind: 'bind', setting: 'sort', key: 'sort' }).plan.extraFrontmatter;
assert.ok(clash.includes('sort: propSort2 = '), clash);

// The props destructure and `interface Props` gain the new prop as text
// edits: one entry per line stays so, one line stays one line, and a name the
// component already has is refused before anything is written.
const loopProps = load('src/editor/loopProps.ts');
const newLimit = { key: 'limit', local: 'propLimit', defaultCode: '3', type: 'number', description: 'Show' };
const typed = loopProps.withProp('interface Props {\n  title?: string;\n}\nconst {\n  title = "x",\n} = Astro.props;\n', newLimit, 0);
assert.equal(
  typed,
  'interface Props {\n  title?: string;\n  /** Show */\n  limit?: number;\n}\nconst {\n  title = "x",\n  limit: propLimit = 3,\n} = Astro.props;\n',
);
assert.equal(loopProps.withProp('const { a } = Astro.props;', newLimit, 0), 'const { a, limit: propLimit = 3 } = Astro.props;');
assert.deepEqual(
  loopProps.readPropsDestructure('const { a, b: c = 1 } = Astro.props;').entries.map((entry) => `${entry.key}:${entry.local}`),
  ['a:a', 'b:c'],
);
assert.throws(() => loopProps.withProp('const { limit } = Astro.props;', newLimit, 0), /not one the component has/);
assert.equal(loopProps.freeLocal('sort', new Set(['propSort', 'propSort2'])), 'propSort3');

// A page using the component edits a list prop with the loop's editors: the
// component says which props hold which setting, over which collection, and
// a value a page passes reads and writes in the helper's data form.
const { listPropsOf } = load('src/editor/listProps.ts');
const optionsQueryModule = load('src/editor/optionsQuery.ts');
const componentText = "import { getCollection } from 'astro:content';\nimport { queryItems } from '@/lib/collection-query';\n" + sortCode;
const listProps = listPropsOf(componentText);
assert.deepEqual([...listProps.keys()].sort(), ['filters', 'sort']);
assert.equal(listProps.get('sort').setting, 'sort');
assert.deepEqual(listProps.get('filters').source, { kind: 'astro', collection: 'campus' });
assert.equal(listProps.get('sort').defaultCode, '[{"field": "name", "direction": "desc"}]');
assert.equal(listPropsOf(optionsCode).size, 0, 'without the getCollection import the list is not a collection’s');
const passed = optionsQueryModule.readFilterValue(
  '{"filterFor": "ANY", "fields": [{"fieldPath": "featured", "operatorName": "eq", "value": "true"}]}',
  () => 'boolean',
);
assert.deepEqual(passed, { match: 'any', conditions: [{ kind: 'test', field: 'featured', operator: 'isTrue' }] });
assert.equal(
  optionsQueryModule.readFilterValue('someVariable', () => 'text'),
  undefined,
  'code is not a filter value',
);
assert.equal(optionsQueryModule.readFilterValue(optionsQueryModule.filterValueText(passed), () => 'boolean').conditions.length, 1);
const passedSort = optionsQueryModule.readSortValue('[{"field": "date", "direction": "desc"}]', () => 'date');
assert.deepEqual(passedSort, [{ field: 'date', direction: 'descending', order: 'date' }]);
assert.equal(optionsQueryModule.sortValueText(passedSort), '[{"field": "date", "direction": "desc"}]');

// A list Stacki wrote as code, in a component: linking a setting first
// rewrites the list as data, read through the listItems helper written above
// it, and then links the setting, as one plan. The helper is run here on
// sample entries to check it gives the same items, in the same order, as the
// code it replaces.
const { LIST_ITEMS_HELPER } = load('src/editor/listItemsHelper.ts');
const codeQuery = {
  ...loopQuery.emptyQuery({ kind: 'astro', collection: 'blog' }),
  conditions: [
    { kind: 'test', field: 'featured', operator: 'isFalse' },
    { kind: 'test', field: 'title', operator: 'contains', value: 'grace' },
    { kind: 'test', field: 'date', operator: 'before', value: '2025-01-01' },
    { kind: 'test', field: 'category', operator: 'is', value: { kind: 'reference', id: 'news' } },
  ],
  sorts: [{ field: 'date', direction: 'descending', order: 'date' }],
  offset: 1,
  limit: 2,
};
const codeFrontmatter = `const posts = ${loopQuery.astroQueryCode(codeQuery)}; // stacki:query`;
const codeLoop = loop('posts.map((post) => (', [{ id: 'title', kind: 'expr', value: 'post.data.title' }]);
const linkCode = (frontmatter, change) =>
  planLoop({
    model: { extraFrontmatter: frontmatter, imports: astroImports, nodes: [codeLoop] },
    loop: codeLoop,
    target: { kind: 'binding', change },
    sanityClient: 'unavailable',
  });
const linkedCode = linkCode(codeFrontmatter, { kind: 'bind', setting: 'filter', key: 'filters' });
assert.equal(linkedCode.ok, true, JSON.stringify(linkedCode));
const linkedText = linkedCode.plan.extraFrontmatter;
assert.ok(linkedText.startsWith(LIST_ITEMS_HELPER), 'the helper is written above the list');
assert.ok(linkedText.includes('\nconst { filters: propFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "featured", "operatorName": "ne"'), linkedText);
assert.ok(linkedText.indexOf('const { filters') < linkedText.indexOf('const posts'), 'the prop is read before the list');
assert.ok(
  linkedText.includes(
    'const posts = listItems(await getCollection("blog"), {"filter": propFilters, "sort": [{"field": "date", "direction": "desc"}], "limit": 2, "offset": 1});',
  ),
  linkedText,
);
assert.equal(linkedCode.plan.loop.head, 'posts.map((post) => (', 'the loop reads the same name');
assert.deepEqual(linkedCode.plan.loop.children, codeLoop.children, 'and its children are untouched');
const linkedReading = readLoop({
  frontmatter: linkedText,
  imports: astroImports,
  data: 'posts',
  fieldKind: (_source, path) => ({ featured: 'boolean', date: 'date', category: 'reference' })[path] ?? 'text',
});
assert.equal(linkedReading.home.settings.filter.kind, 'prop');
assert.equal(linkedReading.query.limit, 2);
assert.equal(linkedReading.query.offset, 1);
assert.deepEqual(linkedReading.query.sorts, codeQuery.sorts);
// A second setting links in place, and the helper is not written twice.
const twice = linkCode(linkedText, { kind: 'bind', setting: 'sort', key: 'sort' }).plan.extraFrontmatter;
assert.equal(twice.split('const listItems = ').length, 2, 'one helper');
assert.ok(twice.includes('"sort": propSort'), twice);
// The helper and the code it replaces agree on sample entries.
const entries = [
  { id: 'a', data: { title: 'Grace one', featured: false, date: new Date('2024-03-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'b', data: { title: 'GRACE two', date: new Date('2024-06-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'c', data: { title: 'Grace three', featured: true, date: new Date('2024-07-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'd', data: { title: 'Grace four', featured: false, date: new Date('2024-09-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'e', data: { title: 'Grace five', featured: false, date: new Date('2025-02-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'f', data: { title: 'Mercy', featured: false, date: new Date('2024-10-01'), category: { id: 'news', collection: 'categories' } } },
  { id: 'g', data: { title: 'Grace six', featured: false, date: new Date('2024-01-01'), category: { id: 'events', collection: 'categories' } } },
  { id: 'h', data: { title: 'Grace seven', featured: false, date: new Date('2024-02-01'), category: 'news' } },
];
const options = JSON.parse(
  linkedText.match(/listItems\(await getCollection\("blog"\), (\{.*\})\);/)[1].replace('propFilters', JSON.stringify(readDefault(linkedText))),
);
function readDefault(text) {
  return JSON.parse(text.match(/propFilters = (\{.*?\}\]\})/)[1]);
}
const helperItems = new Function('items', 'options', `${LIST_ITEMS_HELPER}\nreturn listItems(items, options);`)(entries, options);
const codeItems = new Function('getCollection', `return (async () => ${loopQuery.astroQueryCode(codeQuery)})();`);
void codeItems(async (_name, filter) => (filter ? entries.filter(filter) : entries)).then((expected) => {
  assert.deepEqual(
    helperItems.map((entry) => entry.id),
    expected.map((entry) => entry.id),
    'the helper gives what the code gave',
  );
  assert.deepEqual(
    expected.map((entry) => entry.id),
    ['b', 'a'],
    'newest first, one skipped, two shown',
  );
  console.log('code list to data: ok');
});
// What data cannot say is refused before anything is written.
const shuffledCode = `const posts = ${loopQuery.astroQueryCode({ ...codeQuery, random: true })}; // stacki:query`;
assert.match(linkCode(shuffledCode, { kind: 'bind', setting: 'filter', key: 'filters' }).message, /shuffled/);
const ownHelper = `const listItems = () => [];\n${codeFrontmatter}`;
assert.match(linkCode(ownHelper, { kind: 'bind', setting: 'filter', key: 'filters' }).message, /already has its own listItems/);

// A list inside every item of a collection: the Source picker opens a
// collection and picks a list field in its items. It is written as a marked
// query that reads back as the same field list, never as custom code, and
// running it gathers that field from every item, skipping items without it.
// A Sanity list is a GROQ query that flattens every document's list, and
// follows references when its items are references.
const { fieldListCode, fieldListOf } = load('src/editor/loopFieldList.ts');
const astroReaders = { astro: 'getCollection', sanity: undefined };
const campusPastorsList = { source: { kind: 'astro', collection: 'campus' }, path: ['pastors'], follow: 'values' };
const planField = (list, frontmatter = 'const campusPastors = 1;', imports = astroImports, sanityClient = 'unavailable') =>
  planLoop({ model: { extraFrontmatter: frontmatter, imports, nodes: [codeLoop] }, loop: codeLoop, target: { kind: 'field', list }, sanityClient });
const fieldPlan = planField(campusPastorsList);
assert.equal(fieldPlan.ok, true, JSON.stringify(fieldPlan));
assert.ok(
  fieldPlan.plan.extraFrontmatter.includes(
    'const campusPastors2 = (await getCollection("campus")).flatMap((entry) => entry.data?.pastors ?? []); // stacki:query',
  ),
  fieldPlan.plan.extraFrontmatter,
);
assert.equal(fieldPlan.plan.loop.head, 'campusPastors2.map((post) => (', 'a name in use is not reused');
assert.deepEqual(fieldListOf(fieldPlan.plan.extraFrontmatter, 'campusPastors2', astroReaders), campusPastorsList);
assert.equal(fieldListOf(fieldPlan.plan.extraFrontmatter, 'campusPastors2', { astro: 'other', sanity: undefined }), undefined, 'only through getCollection');
assert.equal(fieldListOf('const x = items.flatMap((e) => e.tags ?? []);', 'x', astroReaders), undefined);
assert.equal(
  fieldListCode({ source: { kind: 'astro', collection: 'team' }, path: ['group-a', 'members'], follow: 'values' }, 'getCollection'),
  '(await getCollection("team")).flatMap((entry) => entry.data?.["group-a"]?.members ?? [])',
);
const gathered = new Function('getCollection', `return (async () => ${fieldListCode(campusPastorsList, 'getCollection')})();`);
void gathered(async () => [{ data: { pastors: ['a', 'b'] } }, { data: {} }, { data: { pastors: ['c'] } }]).then((items) => {
  assert.deepEqual(items, ['a', 'b', 'c']);
  console.log('field lists: ok');
});
const sanityPastors = { source: { kind: 'sanity', collection: 'campus' }, path: ['pastors'], follow: 'references' };
const sanityField = planField(sanityPastors, '', sanityImports, 'available');
assert.ok(
  sanityField.plan.extraFrontmatter.includes('const campusPastors = await sanityClient.fetch("*[_type == \\"campus\\"].pastors[]->"); // stacki:query'),
  sanityField.plan.extraFrontmatter,
);
assert.deepEqual(fieldListOf(sanityField.plan.extraFrontmatter, 'campusPastors', { astro: undefined, sanity: 'sanityClient' }), sanityPastors);
const sanityValues = { ...sanityPastors, path: ['team', 'tags'], follow: 'values' };
assert.equal(fieldListCode(sanityValues, 'client'), 'await client.fetch("*[_type == \\"campus\\"].team.tags[]")');
assert.match(planField(sanityPastors, '', [], 'unavailable').message, /@sanity\/astro/, 'no Sanity client, no Sanity list');
assert.ok(
  planField(sanityPastors, '', [], 'available').plan.imports.some((entry) => entry.path === 'sanity:client'),
  'the client is imported',
);
assert.throws(() => fieldListCode({ ...sanityValues, path: ['a"b'] }, 'client'), /names fields GROQ can/);

// Switching an export's loop to another collection re-points `fields` to `data`.
assert.equal(reboundCode('item0.fields.name', 'item0', { kind: 'astro', fields: new Set(['name']) }), 'item0.data.name');

console.log('builder export: ok');

// --- Selected items ----------------------------------------------------------------
// A list of items picked by hand, in the order picked, in place of filters,
// sort and limit. Each form it can be written in reads back as the same ids,
// with nothing picked included, and ids are escaped like any other value.
const pickedIds = ['b', "o'neil", 'a'];
const astroPicked = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), selection: pickedIds };
const astroPickedCode = loopQuery.astroQueryCode(astroPicked);
assert.ok(parseExpression(astroPickedCode), astroPickedCode);
assert.deepEqual(queryOf(read(`const x = ${astroPickedCode};`, 'x')).selection, pickedIds);
const astroNone = loopQuery.astroQueryCode({ ...astroPicked, selection: [] });
assert.deepEqual(queryOf(read(`const x = ${astroNone};`, 'x')).selection, [], 'nothing picked still names its collection');
// getEntries, as code written elsewhere picks entries.
assert.deepEqual(
  queryOf(
    read("const x = await getEntries([{ collection: 'team', id: 'b' }, { collection: 'team', id: 'a' }]);", 'x', [
      { name: 'getEntries', path: 'astro:content' },
    ]),
  ).selection,
  ['b', 'a'],
);
// A filter by id followed by another sort is not a picked order.
assert.equal(
  read("const x = (await getCollection('team')).filter((entry) => ['a'].includes(entry.id)).sort((a, b) => a.data.n - b.data.n);", 'x').query?.selection,
  undefined,
);
const sanityPicked = loopQuery.sanityQueryCode(
  { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }), selection: ['p2', 'p1'] },
  [],
  'sanityClient',
);
assert.deepEqual(queryOf(read(`const x = ${sanityPicked};`, 'x', sanityImports)).selection, ['p2', 'p1']);
// Switching to Selected writes a list with nothing picked (so Undo switches
// back): read back, it is still a selection of that type, never a dynamic list.
const sanityNone = loopQuery.sanityQueryCode({ ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }), selection: [] }, [], 'sanityClient');
assert.deepEqual(queryOf(read(`const x = ${sanityNone};`, 'x', sanityImports)).selection, [], 'nothing picked from Sanity is still a selection');
const chainNone = loopQuery.chainQueryCode({ ...loopQuery.emptyQuery({ kind: 'astro', collection: 'nav-links' }), selection: [] }, 'collections["nav-links"]', [
  'fields',
]);
assert.deepEqual(readLoop({ frontmatter: collectionsCode + `const items1 = ${chainNone};`, imports: exportImports, data: 'items1' }).query.selection, []);
const exportCurated = collectionsCode + 'const items1 = ["698c", "11ab"].map(id => collections["nav-links"].find(entry => entry.id === id)).filter(Boolean);';
const curatedReading = readLoop({ frontmatter: exportCurated, imports: exportImports, data: 'items1' });
assert.deepEqual(curatedReading.query.selection, ['698c', '11ab']);
assert.equal(curatedReading.home.kind, 'chain');
const reordered = planLoop({
  model: { extraFrontmatter: exportCurated, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...curatedReading.query, selection: ['11ab', '698c'] }, fields: [] },
  sanityClient: 'unavailable',
});
assert.ok(
  reordered.plan.extraFrontmatter.endsWith(
    `const items1 = ['11ab', '698c'].map((id) => collections["nav-links"].find((entry) => entry.id === id)).filter(Boolean);`,
  ),
);
// Back to Dynamic: the kept list, every item.
const dynamicAgain = planLoop({
  model: { extraFrontmatter: exportCurated, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: loopQuery.emptyQuery({ kind: 'astro', collection: 'nav-links' }), fields: [] },
  sanityClient: 'unavailable',
});
assert.ok(dynamicAgain.plan.extraFrontmatter.endsWith('const items1 = [...collections["nav-links"]];'));
// A builder's options keep picked items in `curated`.
const optionsPicked = optionsCode.replace('"limit": 6', '"curated": {"itemIds": ["q1"]}, "limit": 6');
const optionsPickedReading = readLoop({ frontmatter: optionsPicked, imports: exportImports, data: 'items1' });
assert.deepEqual(optionsPickedReading.query.selection, ['q1']);
const optionsRepicked = planLoop({
  model: { extraFrontmatter: optionsPicked, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...optionsPickedReading.query, selection: ['q2', 'q1'] }, fields: [] },
  sanityClient: 'unavailable',
});
assert.deepEqual(readLoop({ frontmatter: optionsRepicked.plan.extraFrontmatter, imports: exportImports, data: 'items1' }).query.selection, ['q2', 'q1']);
// A selection carries none of a dynamic list's settings.
assert.throws(() => loopQuery.astroQueryCode({ ...astroPicked, limit: 3 }), /A selected list has no limit/);
assert.throws(() => loopQuery.astroQueryCode({ ...astroPicked, selection: ['a\nb'] }), /A selected item is named by an id/);

console.log('selected items: ok');

// --- Sorting by what a value measures ------------------------------------------
// Text with its numbers in order, text by length, a list by its count, and an
// image by its file's size are JavaScript the writer emits after the fetch;
// each must read back as the same sort, with the field's kind not turning it
// back into a plain one. GROQ cannot say them, so a Sanity query refuses them.
{
  const kinds = { title: 'text', tags: 'list', Picture: 'image' };
  const fieldKind = (_source, path) => kinds[path] ?? 'number';
  const measured = [
    { field: 'title', direction: 'ascending', order: 'natural' },
    { field: 'title', direction: 'descending', order: 'length' },
    { field: 'tags', direction: 'descending', order: 'count' },
    { field: 'Picture', direction: 'ascending', order: 'fileSize' },
    { field: 'Picture.width', direction: 'descending', order: 'number' },
  ];
  for (const sort of measured) {
    const query = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), sorts: [sort] };
    const code = loopQuery.astroQueryCode(query);
    parseExpression(code.replace(/^\(?await /, '('));
    assert.deepEqual(queryOf(read(`const x = ${code};`, 'x', astroImports, fieldKind)).sorts, [sort], code);
    const chained = loopQuery.chainQueryCode({ ...query, source: { kind: 'astro', collection: 'nav-links' } }, 'collections["nav-links"]', ['fields']);
    assert.deepEqual(
      readLoop({ frontmatter: collectionsCode + `const items1 = ${chained};`, imports: exportImports, data: 'items1', fieldKind }).query.sorts,
      [sort],
      chained,
    );
  }
  // All four keys in one comparator, as ties broken in order.
  const several = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), sorts: measured.slice(0, 3) };
  assert.deepEqual(queryOf(read(`const x = ${loopQuery.astroQueryCode(several)};`, 'x', astroImports, fieldKind)).sorts, measured.slice(0, 3));
  // A field that happens to be named length is a number, not a measure.
  assert.deepEqual(queryOf(read("const x = (await getCollection('team')).sort((a, b) => a.data.tags.length - b.data.tags.length);", 'x')).sorts, [
    { field: 'tags.length', direction: 'ascending', order: 'number' },
  ]);
  // The file size of a page with no file system, or no image, is 0: never a throw.
  const sizeOf = new Function(
    'image',
    `return ${loopQuery
      .astroQueryCode({ ...loopQuery.emptyQuery({ kind: 'astro', collection: 't' }), sorts: [measured[3]] })
      .match(/\(globalThis[^]*?\?\? 0\)/)[0]
      .replace('a.data.Picture', 'image')};`,
  );
  assert.equal(sizeOf(undefined), 0);
  assert.equal(sizeOf({ fsPath: '/no/such/file.png' }), 0);
  assert.ok(sizeOf({ fsPath: __filename }) > 0, 'a real file has its size');
  assert.deepEqual(loopQuery.sortOrdersFor('text', 'astro'), ['text', 'natural', 'length']);
  assert.deepEqual(loopQuery.sortOrdersFor('text', 'sanity'), ['text']);
  assert.deepEqual(loopQuery.sortOrdersFor('image', 'sanity'), []);
  assert.throws(
    () => loopQuery.sanityQueryCode({ ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }), sorts: [measured[0]] }, [], 'sanityClient'),
    /A Sanity query sorts by values GROQ compares/,
  );
  // An image's width filters as a number, and an entry with no image is simply left out.
  const wide = loopQuery.astroQueryCode({
    ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }),
    conditions: [{ kind: 'test', field: 'Picture.width', operator: 'greater', value: 400 }],
  });
  const filter = new Function(`return ${wide.match(/\(\{ data \}\) => .*?(?=\))/)[0]};`)();
  assert.equal(filter({ data: {} }), false, 'no picture: no width, no throw');
  assert.equal(filter({ data: { Picture: { width: 800 } } }), true);
  assert.deepEqual(queryOf(read(`const x = ${wide};`, 'x')).conditions, [{ kind: 'test', field: 'Picture.width', operator: 'greater', value: 400 }]);
  console.log('measured sorts: ok');
}

// --- Custom code: a filter or a sort no menu can say ------------------------------
// Typed in the panel (or written by an AI), kept verbatim, and read back as the
// same custom code rather than turning the whole list into uneditable code.
{
  const comparator = '(a, b) => (a.data.order ?? 99) - (b.data.order ?? 99) || a.id.localeCompare(b.id)';
  const astro = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), customSort: comparator, limit: 3 };
  const astroCode = loopQuery.astroQueryCode(astro);
  const astroBack = queryOf(read(`const x = ${astroCode};`, 'x'));
  assert.equal(astroBack.customSort, comparator, astroCode);
  assert.deepEqual(astroBack.sorts, []);
  assert.equal(astroBack.limit, 3);
  // Reversing a custom sort is beyond the panel: the list stays code.
  assert.notEqual(read(`const x = (await getCollection('team')).sort(${comparator}).reverse();`, 'x').kind, 'query');

  const chainComparator = '(a, b) => a.fields.rank - b.fields.rank * 2';
  const chained = loopQuery.chainQueryCode(
    { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'nav-links' }), customSort: chainComparator },
    'collections["nav-links"]',
    ['fields'],
  );
  assert.equal(
    readLoop({ frontmatter: collectionsCode + `const items1 = ${chained};`, imports: exportImports, data: 'items1' }).query.customSort,
    chainComparator,
  );

  // Sanity: the comparator runs on the fetched list, and so does the limit after it.
  const sanity = { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }), customSort: '(a, b) => a.name.length - b.name.length * 2', limit: 4 };
  const sanityCode = loopQuery.sanityQueryCode(sanity, [], 'sanityClient');
  assert.match(sanityCode, /\.sort\(\(a, b\) => a\.name\.length - b\.name\.length \* 2\)\.slice\(0, 4\)$/);
  assert.doesNotMatch(loopQuery.groqQueryText(sanity, []), /\[0\.\.\.4\]/, 'not sliced before the sort');
  const sanityBack = queryOf(read(`const x = ${sanityCode};`, 'x', sanityImports));
  assert.equal(sanityBack.customSort, sanity.customSort);
  assert.equal(sanityBack.limit, 4);

  // Custom filters: JavaScript over an entry's data, or a GROQ clause.
  const filtered = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), conditions: [{ kind: 'custom', code: 'data.title.startsWith("S")' }] };
  assert.deepEqual(queryOf(read(`const x = ${loopQuery.astroQueryCode(filtered)};`, 'x')).conditions, filtered.conditions);
  const groqFiltered = { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }), conditions: [{ kind: 'custom', code: 'count(serviceTimes) > 1' }] };
  assert.deepEqual(
    queryOf(read(`const x = ${loopQuery.sanityQueryCode(groqFiltered, [], 'sanityClient')};`, 'x', sanityImports)).conditions,
    groqFiltered.conditions,
  );

  // A custom sort replaces the keys and the shuffle, and a picked list keeps its order.
  assert.throws(
    () => loopQuery.astroQueryCode({ ...astro, sorts: [{ field: 'title', direction: 'ascending', order: 'text' }] }),
    /A custom sort replaces the sort keys/,
  );
  assert.throws(() => loopQuery.astroQueryCode({ ...astro, random: true }), /A custom sort is not a shuffle/);
  assert.throws(() => loopQuery.astroQueryCode({ ...astro, customSort: ' ' }), /A custom sort holds code/);
  assert.throws(
    () => loopQuery.astroQueryCode({ ...astro, customSort: 'x'.repeat(loopQuery.LOOP_QUERY_LIMITS.customCodeCharsMax + 1) }),
    /A custom sort is bounded/,
  );
  console.log('custom code: ok');
}

// Nested fields from the Field picker: written and read back by their dotted
// paths, in GROQ as in JavaScript (where `?.` keeps a missing parent safe).
{
  const lat = { kind: 'test', field: 'location.lat', operator: 'greater', value: 30 };
  const bySlug = { field: 'hero.slug.current', direction: 'descending', order: 'text' };
  const sanity = { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }), conditions: [lat], sorts: [bySlug] };
  const groq = loopQuery.groqQueryText(sanity, []);
  assert.match(groq, /location\.lat > 30/);
  assert.match(groq, /order\(hero\.slug\.current desc\)/);
  const back = queryOf(read(`const x = ${loopQuery.sanityQueryCode(sanity, [], 'sanityClient')};`, 'x', sanityImports, () => 'text'));
  assert.deepEqual(back.conditions, [lat]);
  assert.deepEqual(back.sorts, [bySlug]);
  const astro = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'campus' }), conditions: [lat], sorts: [bySlug] };
  const code = loopQuery.astroQueryCode(astro);
  assert.match(code, /data\.location\?\.lat > 30/);
  const astroBack = queryOf(read(`const x = ${code};`, 'x', astroImports, (_source, path) => (path === 'location.lat' ? 'number' : 'text')));
  assert.deepEqual(astroBack.conditions, [lat]);
  assert.deepEqual(astroBack.sorts, [bySlug]);
  console.log('nested paths: ok');
}

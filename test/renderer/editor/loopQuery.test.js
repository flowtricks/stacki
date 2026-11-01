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
const read = (frontmatter, data, imports = astroImports, fieldKind) =>
  readLoop({ frontmatter, imports, data, fieldKind });
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
    const query = queryOf(
      read(
        `const posts = (await getCollection('blog')).${method}(${comparator});`,
        'posts.slice(0, 3)',
        astroImports,
        () => 'date',
      ),
    );
    assert.deepEqual(
      query.sorts,
      [{ field: 'date', direction: 'descending', order: 'date' }],
      comparator,
    );
    assert.equal(query.limit, 3);
  }
}
assert.deepEqual(
  queryOf(
    read(
      "const p = (await getCollection('blog')).sort((x, y) => x.data.title.localeCompare(y.data.title)).reverse();",
      'p',
    ),
  ).sorts,
  [{ field: 'title', direction: 'descending', order: 'text' }],
);
assert.equal(
  queryOf(read("const p = (await getCollection('blog')).sort(() => Math.random() - 0.5);", 'p'))
    .random,
  true,
);
assert.deepEqual(queryOf(read('', "(await getCollection('blog')).slice(2, 5)")).offset, 2);

// An aliased import is still astro:content's getCollection.
assert.equal(
  queryOf(
    read("const p = await load('team');", 'p', [
      { name: 'load', imported: 'getCollection', path: 'astro:content' },
    ]),
  ).source.collection,
  'team',
);

// A clause the settings cannot show is kept as written, around the ones they can.
const envDrafts = queryOf(
  read(
    "const p = await getCollection('blog', ({ data }) => (import.meta.env.PROD ? !data.draft : true) && data.n > 2);",
    'p',
  ),
);
assert.equal(envDrafts.conditions[0].kind, 'custom');
assert.equal(envDrafts.conditions[0].code, 'import.meta.env.PROD ? !data.draft : true');
assert.deepEqual(envDrafts.conditions[1], {
  kind: 'test',
  field: 'n',
  operator: 'greater',
  value: 2,
});

// Truthiness means "is on" only for a switch; on text it is code.
const kinds = (kind) => () => kind;
assert.equal(
  queryOf(
    read(
      "const p = await getCollection('b', ({ data }) => data.image);",
      'p',
      astroImports,
      kinds('image'),
    ),
  ).conditions[0].kind,
  'custom',
);
assert.equal(
  queryOf(
    read(
      "const p = await getCollection('b', ({ data }) => data.on);",
      'p',
      astroImports,
      kinds('boolean'),
    ),
  ).conditions[0].operator,
  'isTrue',
);

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
assert.deepEqual(
  read('const pastors = await getCampusPastors();', 'pastors', [
    { name: 'getCampusPastors', path: '@/sanity/queries' },
  ]).origin,
  {
    kind: 'call',
    exportName: 'getCampusPastors',
    spec: '@/sanity/queries',
  },
);
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
assert.equal(
  readGroq('*[_type == "post" && slug.current == $slug][0]'),
  undefined,
  'parameters stay custom',
);
assert.equal(
  readGroq('*[_type == "a"] { x } | order(x asc)'),
  undefined,
  'a projection before order is code',
);
assert.equal(
  readGroq('*[_type == "a" || _type == "b"]'),
  undefined,
  'two types is not one collection',
);

// --- Writing: every written query reads back as itself ----------------------------

const hostile = 'it\'s "quoted" \\ back`slash ${x}\n ';
const astroQuery = {
  ...loopQuery.emptyQuery({ kind: 'astro', collection: 'case-studies' }),
  conditions: [
    { kind: 'test', field: 'title', operator: 'is', value: { kind: 'text', text: hostile } },
    {
      kind: 'test',
      field: 'category',
      operator: 'is',
      value: { kind: 'reference', id: 'get-involved' },
    },
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
    { field: 'date', direction: 'descending', order: 'date' },
    { field: 'title', direction: 'ascending', order: 'text' },
  ],
  offset: 2,
  limit: 4,
};
const astroCode = loopQuery.astroQueryCode(astroQuery);
assert.ok(parseExpression(astroCode), astroCode);
const fieldKinds = {
  category: 'reference',
  tags: 'list',
  image: 'image',
  live: 'boolean',
  date: 'date',
  rank: 'number',
};
const astroBack = queryOf(
  read(`const x = ${astroCode};`, 'x', astroImports, (_source, path) => fieldKinds[path] ?? 'text'),
);
assert.deepEqual(
  astroBack.conditions,
  astroQuery.conditions.map((condition) =>
    condition.operator === 'contains' ? { ...condition, value: 'grace' } : condition,
  ),
);
assert.deepEqual(astroBack.sorts, astroQuery.sorts);
assert.equal(astroBack.offset, 2);
assert.equal(astroBack.limit, 4);
assert.ok(
  astroCode.includes('(data.category?.id ?? data.category)'),
  'a choice or reference compares by id',
);
assert.ok(
  astroCode.includes("data['campus-name']"),
  'a field name that is not an identifier is indexed',
);

const sanityQuery = {
  ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'sermon' }),
  match: 'any',
  conditions: [
    { kind: 'test', field: 'speaker', operator: 'is', value: { kind: 'reference', id: 'abc-123' } },
    { kind: 'test', field: 'title', operator: 'contains', value: hostile },
    {
      kind: 'test',
      field: 'slug.current',
      operator: 'isNot',
      value: { kind: 'text', text: 'home' },
    },
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
assert.throws(
  () => loopQuery.astroQueryCode({ ...astroQuery, limit: 0 }),
  /A limit shows at least one item/,
);
assert.throws(
  () =>
    loopQuery.astroQueryCode({
      ...astroQuery,
      conditions: [{ kind: 'test', field: 'a b', operator: 'isSet' }],
    }),
  /field path segment/,
);
assert.throws(
  () =>
    loopQuery.astroQueryCode({
      ...astroQuery,
      conditions: [{ kind: 'test', field: 'd', operator: 'before', value: 'soon' }],
    }),
  /YYYY-MM-DD/,
);
assert.throws(
  () =>
    loopQuery.astroQueryCode({
      ...astroQuery,
      source: { kind: 'astro', collection: "x'); evil(" },
    }),
  /names a collection/,
);

// --- Planning: one change, nothing left behind -------------------------------------

const loop = (head, children = []) => ({ id: 'loop', kind: 'map', head, children });
const pastorChildren = [
  {
    id: 'img',
    kind: 'element',
    name: 'img',
    props: {
      src: { type: 'expr', value: 'pastor.image' },
      alt: { type: 'expr', value: 'pastor.name' },
    },
    children: [],
  },
  { id: 'role', kind: 'expr', value: 'pastor.role' },
  { id: 'if', kind: 'cond', test: 'pastor.featured', children: [] },
];
const handWritten = {
  extraFrontmatter:
    'const title = "Home";\nconst campusPastors = await getCampusPastors();\nconst other = 1;',
  imports: [
    {
      name: 'getCampusPastors',
      imported: 'getCampusPastors',
      path: '@/sanity/queries.ts',
      quote: '"',
      named: true,
    },
  ],
  nodes: [loop('campusPastors.map((pastor) => (', pastorChildren)],
};
const teamFields = [
  { path: 'name', title: 'Name', kind: 'text', options: [] },
  { path: 'image', title: 'Image', kind: 'image', options: [] },
];
const toTeam = planLoop({
  model: handWritten,
  loop: handWritten.nodes[0],
  target: {
    kind: 'query',
    query: { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), limit: 4 },
    fields: teamFields,
  },
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
assert.equal(
  toTeam.plan.loop.children[1].kind,
  'text',
  'a field the new collection lacks is unbound, not left to throw',
);
assert.equal(toTeam.plan.loop.children[2].test, 'false');
assert.equal(toTeam.plan.unbound, 2);

// Back to nothing: the file is as it was before any query.
const after = {
  ...handWritten,
  extraFrontmatter: toTeam.plan.extraFrontmatter,
  imports: toTeam.plan.imports,
  nodes: [toTeam.plan.loop],
};
const cleared = planLoop({
  model: after,
  loop: toTeam.plan.loop,
  target: { kind: 'empty' },
  sanityClient: 'available',
});
assert.equal(cleared.plan.extraFrontmatter, 'const title = "Home";\nconst other = 1;');
assert.deepEqual(cleared.plan.imports, []);
assert.equal(cleared.plan.loop.head, '[].map((pastor) => (');

// Read by something else, the old source stays, and the new one is added.
const shared = {
  ...handWritten,
  nodes: [...handWritten.nodes, { id: 'count', kind: 'expr', value: 'campusPastors.length' }],
};
const kept = planLoop({
  model: shared,
  loop: shared.nodes[0],
  target: {
    kind: 'query',
    query: loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }),
    fields: teamFields,
  },
  sanityClient: 'unavailable',
});
assert.ok(kept.plan.extraFrontmatter.includes('const campusPastors = await getCampusPastors();'));
assert.ok(
  kept.plan.extraFrontmatter.endsWith(
    "const teamEntries = await getCollection('team'); // stacki:query",
  ),
);
assert.ok(kept.plan.imports.some((entry) => entry.name === 'getCampusPastors'));

// A GROQ constant the old query fetched goes with it; an export never does.
const groqPage = {
  extraFrontmatter:
    'const Q = defineQuery(`*[_type == "pastor"]`);\nconst pastors = await sanityClient.fetch(Q);\nexport const prerender = true;',
  imports: [...sanityImports.map((entry) => ({ ...entry, quote: "'", named: true }))],
  nodes: [loop('pastors.map((pastor) => (')],
};
const narrowed = planLoop({
  model: groqPage,
  loop: groqPage.nodes[0],
  target: {
    kind: 'query',
    query: { ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }), limit: 3 },
    fields: [],
  },
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
  target: {
    kind: 'query',
    query: loopQuery.emptyQuery({ kind: 'sanity', collection: 'pastor' }),
    fields: [],
  },
  sanityClient: 'unavailable',
});
assert.equal(refused.ok, false);
assert.match(refused.message, /@sanity\/astro/);

// A hand-written loop head is not planned over.
assert.equal(
  planLoop({
    model: handWritten,
    loop: loop('items.flatMap(({ a }) => ('),
    target: { kind: 'empty' },
    sanityClient: 'available',
  }).ok,
  false,
);

// --- Rebinding ---------------------------------------------------------------------

const toSanity = { kind: 'sanity', fields: new Set(['title', 'author']) };
assert.equal(
  reboundCode('item.data.title + item.data.author?.name', 'item', toSanity),
  'item.title + item.author.name',
);
assert.equal(reboundCode('item._id', 'item', toSanity), 'item._id');
assert.equal(reboundCode('item.data.body', 'item', toSanity), undefined);
assert.equal(
  reboundCode('items.length + other.item', 'item', toSanity),
  'items.length + other.item',
  'only the item itself is re-pointed',
);
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
  props: {
    href: { type: 'expr', value: 'item.data.url' },
    title: { type: 'expr', value: 'item.data.title' },
    class: { type: 'string', value: 'x' },
  },
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
const untouched = {
  ...spanned,
  props: { class: { type: 'string', value: 'x' } },
  attrOrder: ['class'],
};
assert.deepEqual(
  reboundItem([untouched], 'item', { kind: 'sanity', fields: new Set() }).nodes[0].attrSpans,
  untouched.attrSpans,
);

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
  planLoop({
    model: handWritten,
    loop: original,
    target: { kind: 'value', data: 'campusPastors' },
    sanityClient: 'available',
    restore: [],
  }).plan.restored,
  false,
);
// Ids and positions a re-parse renews do not count as a change.
assert.equal(
  childrenFingerprint([{ ...spanned, id: 'z', start: 4 }]),
  childrenFingerprint([spanned]),
);
assert.notEqual(childrenFingerprint([{ ...spanned, name: 'b' }]), childrenFingerprint([spanned]));

// --- Syntax ------------------------------------------------------------------------

const declarations = parseFrontmatter(
  'const a = 1, b = 2;\nexport const c = 3; // note\nconst { d } = e;\n',
).declarations;
assert.equal(declarations.get('a').alone, false);
assert.equal(
  declarations.get('c').statement.to,
  'const a = 1, b = 2;\nexport const c = 3; // note\n'.length,
);
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
const astroFile =
  "import { getCollection as all } from 'astro:content';\nexport function posts() { return all('blog'); }";
assert.deepEqual(traceFunction(astroFile, 'src/lib/posts.ts', 'posts').steps[1].source, {
  kind: 'astro',
  collection: 'blog',
});
// A name the file does not define traces to itself and stops.
assert.deepEqual(traceFunction(astroFile, 'src/lib/posts.ts', 'missing').steps, [
  { kind: 'function', name: 'missing', file: 'src/lib/posts.ts' },
]);

// Editing a traced query rewrites only its string literal, in its own quotes,
// and keeps the projection; a file changed since the trace is left alone.
const literal = pastors.steps[2].literal;
assert.equal(queriesFile.slice(literal.from, literal.to).startsWith('`*[_type == "campus"'), true);
const narrowedQuery = {
  ...loopQuery.emptyQuery({ kind: 'sanity', collection: 'campus' }),
  conditions: [
    ...pastors.steps[2].groq.conditions,
    { kind: 'test', field: 'name', operator: 'is', value: { kind: 'text', text: 'a`b${c}' } },
  ],
  projection: pastors.steps[2].groq.projection,
  limit: 3,
};
const rewritten = rewrittenGroqLiteral(
  queriesFile,
  literal,
  loopQuery.groqQueryText(narrowedQuery, []),
);
assert.ok(rewritten.startsWith(queriesFile.slice(0, literal.from)));
assert.ok(rewritten.endsWith(queriesFile.slice(literal.to)));
const reread = traceFunction(rewritten, 'src/sanity/queries.ts', 'getCampusPastors').steps[2];
assert.deepEqual(reread.groq.conditions, narrowedQuery.conditions);
assert.equal(reread.groq.limit, 3);
assert.equal(reread.groq.projection, '{ name }');
assert.equal(
  rewrittenGroqLiteral(
    queriesFile.replace('pastorName', 'pastorTitle'),
    literal,
    '*[_type == "x"]',
  ),
  undefined,
);

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
const generatedQuery = queryOf(
  readLoop({
    frontmatter: generated,
    imports: exportImports,
    data: 'items1',
    fieldKind: () => 'text',
  }),
);
assert.equal(generatedQuery.source.collection, 'nav-links');
assert.deepEqual(generatedQuery.conditions, [
  { kind: 'test', field: 'category', operator: 'is', value: { kind: 'text', text: 'Care' } },
]);
assert.deepEqual(generatedQuery.sorts, [
  { field: 'sort-order', direction: 'descending', order: 'text' },
]);
const exportLoop = loop('items1.map((item0) => (', [
  { id: 'name', kind: 'expr', value: 'item0.fields.name' },
]);
const generatedPlan = planLoop({
  model: { extraFrontmatter: generated, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: { kind: 'query', query: { ...generatedQuery, limit: 4 }, fields: [] },
  sanityClient: 'unavailable',
});
assert.ok(
  generatedPlan.plan.extraFrontmatter.startsWith(collectionsCode),
  'the list it reads is kept as written',
);
assert.match(
  generatedPlan.plan.extraFrontmatter,
  /const items1 = \[\.\.\.collections\["nav-links"\]\]\.filter\(\(entry\) => entry\.fields\.category === 'Care'\)/,
);
assert.equal(generatedPlan.plan.loop, exportLoop, 'the loop and its bindings are untouched');
assert.equal(
  queryOf(
    readLoop({
      frontmatter: generatedPlan.plan.extraFrontmatter,
      imports: exportImports,
      data: 'items1',
      fieldKind: () => 'text',
    }),
  ).limit,
  4,
);
// An unfiltered list is a collection too, with nothing set.
assert.equal(
  readLoop({
    frontmatter: collectionsCode + 'const items1 = [...collections["nav-links"]];',
    imports: exportImports,
    data: 'items1',
  }).home.kind,
  'chain',
);
// "0 days in the past" is the build date.
const relative = generated
  .replace('let expected0 = "Care"', 'let expected0 = "0 days in the past"')
  .replace('(value0 === expected0)', '(value0 >= expected0)');
assert.equal(
  queryOf(
    readLoop({
      frontmatter: relative,
      imports: exportImports,
      data: 'items1',
      fieldKind: () => 'date',
    }),
  ).conditions[0].operator,
  'inFuture',
);

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
assert.equal(optionsReading.home.filter.kind, 'prop');
assert.deepEqual(optionsReading.query.conditions, [
  { kind: 'test', field: 'featured', operator: 'isTrue' },
]);
assert.deepEqual(optionsReading.query.sorts, [
  { field: 'name', direction: 'descending', order: 'text' },
]);
assert.equal(optionsReading.query.limit, 6);
const optionsPlan = planLoop({
  model: { extraFrontmatter: optionsCode, imports: exportImports, nodes: [exportLoop] },
  loop: exportLoop,
  target: {
    kind: 'query',
    query: {
      ...optionsReading.query,
      conditions: [{ kind: 'test', field: 'name', operator: 'contains', value: 'Prairie' }],
      limit: undefined,
      offset: 1,
    },
    fields: [],
  },
  sanityClient: 'unavailable',
});
const written = optionsPlan.plan.extraFrontmatter;
assert.ok(
  written.includes(
    'filters: propFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "name", "operatorName": "contains", "value": "Prairie"}]}',
  ),
  'filters go to the prop default',
);
assert.ok(
  written.includes(
    '({"usePrimaryLocale": false, "sort": [{"field": "name", "direction": "desc"}], "filter": propFilters, "limit": 0, "offset": 1})',
  ),
  'other keys are kept',
);
const optionsBack = readLoop({
  frontmatter: written,
  imports: exportImports,
  data: 'items1',
}).query;
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
// Switching an export's loop to another collection re-points `fields` to `data`.
assert.equal(
  reboundCode('item0.fields.name', 'item0', { kind: 'astro', fields: new Set(['name']) }),
  'item0.data.name',
);

console.log('builder export: ok');

// Goal: everything Stacki accepts about EmDash from disk, from its database or across the IPC boundary is parsed
// first: a schema export or seed becomes content types and fields, a wrong file is an error and never an empty
// site, EmDash's own slug rules and bounds are enforced, a field type this version does not know is listed as
// unsupported and never bound, and the project result that crosses to the renderer round-trips or is refused.
// Method: each known-good shape (the real schema export and seed layouts) and each known-bad one, directly on the
// parsers; the binding table is checked against every field type EmDash defines so a new type cannot go unmapped.
const test = require('node:test');
const assert = require('node:assert/strict');
const emdash = require('#dist/shared/properties/emdash.js');

const posts = { slug: 'posts', label: 'Posts', fields: [{ slug: 'title', label: 'Title', type: 'string', required: true }] };

test('a schema export and a seed both parse to content types with fields', () => {
  const parsed = emdash.parseEmDashSchema({ collections: [posts], version: 'abc' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, [
    {
      slug: 'posts',
      label: 'Posts',
      labelSingular: undefined,
      urlPattern: undefined,
      fields: [{ slug: 'title', label: 'Title', type: 'string', required: true, options: [], binding: 'text' }],
    },
  ]);
  const seed = emdash.parseEmDashSchema({ version: '1', collections: [{ ...posts, urlPattern: '/blog/{slug}', labelSingular: 'Post' }] });
  assert.equal(seed.value[0].urlPattern, '/blog/{slug}');
  assert.equal(seed.value[0].labelSingular, 'Post');
});

test('a document that is not a schema is an error, so a wrong file is never read as an empty site', () => {
  // eslint-disable-next-line stacki/no-null -- A JSON null is one of the wrong documents a schema file can hold.
  for (const bad of [undefined, null, 7, 'text', [], {}, { collections: 'posts' }, { collections: {} }]) {
    const parsed = emdash.parseEmDashSchema(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
  const many = { collections: Array.from({ length: emdash.EMDASH_LIMITS.collectionsMax + 1 }, (_, index) => ({ slug: `c${index}`, label: 'C', fields: [] })) };
  assert.deepEqual(emdash.parseEmDashSchema(many), { ok: false, error: 'too-many' });
});

test('slugs EmDash itself would refuse are left out, and duplicates keep the first', () => {
  const parsed = emdash.parseEmDashSchema({
    collections: [
      posts,
      { slug: 'Bad-Slug', label: 'x', fields: [] },
      { slug: 'posts', label: 'Again', fields: [] },
      {
        slug: 'mixed',
        label: 'Mixed',
        fields: [
          { slug: 'ok_field', label: 'Fine', type: 'text' },
          { slug: 'Bad Field', label: 'x', type: 'text' },
          { slug: 'ok_field', label: 'Twice', type: 'text' },
        ],
      },
    ],
  });
  assert.deepEqual(
    parsed.value.map((collection) => collection.slug),
    ['posts', 'mixed'],
  );
  assert.deepEqual(
    parsed.value[1].fields.map((field) => field.label),
    ['Fine'],
  );
  assert.equal(parsed.value[0].label, 'Posts');
});

test('fields are bounded, and a missing label falls back to the slug', () => {
  const fields = Array.from({ length: emdash.EMDASH_LIMITS.fieldsMax + 20 }, (_, index) => ({ slug: `f${index}`, type: 'string' }));
  const parsed = emdash.parseEmDashSchema({ collections: [{ slug: 'big', fields }] });
  assert.equal(parsed.value[0].fields.length, emdash.EMDASH_LIMITS.fieldsMax);
  assert.equal(parsed.value[0].label, 'big');
  assert.equal(parsed.value[0].fields[0].label, 'f0');
});

test('select choices come from validation.options, bounded and text only', () => {
  const parsed = emdash.parseEmDashSchema({
    collections: [{ slug: 'a', fields: [{ slug: 'tone', type: 'select', validation: { options: ['x', 7, '', 'y'] } }] }],
  });
  assert.deepEqual(parsed.value[0].fields[0].options, ['x', 'y']);
});

test('every field type EmDash defines has a binding, and an unknown one is data and unsupported', () => {
  for (const type of emdash.EMDASH_FIELD_TYPES) {
    assert.ok(typeof emdash.bindingOf(type) === 'string', type);
  }
  assert.equal(emdash.bindingOf('unsupported'), 'data');
  const parsed = emdash.parseEmDashSchema({ collections: [{ slug: 'a', fields: [{ slug: 'x', type: 'teleporter' }] }] });
  assert.equal(parsed.value[0].fields[0].type, 'unsupported');
  assert.deepEqual(emdash.recipeFor('richText'), { kind: 'component', name: 'PortableText', prop: 'value' });
  assert.deepEqual(emdash.recipeFor('image'), { kind: 'component', name: 'Image', prop: 'image' });
  assert.deepEqual(emdash.recipeFor('data'), { kind: 'none' });
});

test('the heading is the title-like string field, else the first string field, else none', () => {
  const field = (slug, type) => ({ slug, label: slug, type, required: false, options: [], binding: emdash.bindingOf(type) });
  assert.equal(emdash.headingFieldOf({ fields: [field('summary', 'string'), field('title', 'string')] }), 'title');
  assert.equal(emdash.headingFieldOf({ fields: [field('summary', 'string')] }), 'summary');
  assert.equal(emdash.headingFieldOf({ fields: [field('body', 'portableText')] }), undefined);
});

test('a field is read from an entry as entry.data.<slug>, and only for names that are identifiers', () => {
  assert.equal(emdash.emDashFieldExpression('post', { slug: 'featured_image' }), 'post.data.featured_image');
  assert.throws(() => emdash.emDashFieldExpression('post', { slug: 'a-b' }), /identifier/);
  assert.throws(() => emdash.emDashFieldExpression('post; x', { slug: 'a' }), /name/);
});

test('the project result round-trips, and a broken one is refused', () => {
  const project = {
    kind: 'present',
    configFile: 'astro.config.mjs',
    output: 'server',
    databaseFile: undefined,
    schemaSource: 'seed',
    collections: emdash.parseEmDashSchema({ collections: [posts] }).value,
    problems: ['noDatabase'],
  };
  // JSON drops what is undefined, as the IPC does; the optional keys are then simply absent on both sides.
  const wire = JSON.parse(JSON.stringify(project));
  assert.deepEqual(JSON.parse(JSON.stringify(emdash.parseEmDashProject(wire))), wire);
  assert.deepEqual(emdash.parseEmDashProject({ kind: 'absent' }), { kind: 'absent' });
  const broken = [
    undefined,
    {},
    { kind: 'maybe' },
    { ...project, output: 'edge' },
    { ...project, problems: ['tooSpooky'] },
    { ...project, schemaSource: 'guess' },
    { ...project, collections: [{ slug: 'Not A Slug', label: 'x', fields: [] }] },
    { ...project, collections: 'posts' },
  ];
  for (const input of broken) {
    assert.throws(() => emdash.parseEmDashProject(input), undefined, JSON.stringify(input));
  }
});

test('collection names are slugs, the only form that may become code or SQL', () => {
  assert.equal(emdash.parseEmDashCollectionName('case_studies'), 'case_studies');
  for (const bad of ['', 'Posts', 'a-b', 'a.b', 'a b', "a'", 'a;b', '9a', 5]) {
    assert.throws(() => emdash.parseEmDashCollectionName(bad), undefined, String(bad));
  }
  assert.equal(emdash.isEmDashCollectionSlug('posts'), true);
  assert.equal(emdash.isEmDashCollectionSlug('x'.repeat(emdash.EMDASH_LIMITS.slugCharsMax + 1)), false);
});

test('entries are bounded', () => {
  assert.deepEqual(emdash.parseEmDashEntries([{ slug: 'a', title: 'A' }]), [{ slug: 'a', title: 'A' }]);
  assert.throws(() => emdash.parseEmDashEntries([{ slug: 'a' }]));
  assert.throws(() => emdash.parseEmDashEntries(Array.from({ length: emdash.EMDASH_LIMITS.entriesMax + 1 }, () => ({ slug: 'a', title: 'A' }))));
});

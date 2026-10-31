// Goal: a Sanity item's fields come from the site's own schema code — in its order, with titles,
// help text, whether each is required, and types resolved through named types — and the fields
// the Studio hides stay hidden.
// Method: schema text shaped like a real `defineType` file (nested objects, references, image
// lists, rich text named in another file, a spread plugin field, comments with apostrophes and
// commas inside strings) is read, then the same files are read from a project folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  definedTypes,
  iconSymbol,
  sanityConstantLists,
  sanityDocumentSchema,
  sanityNamedTypes,
} = require('#dist/electron/content/sanitySchema.js');

const CAMPUS = `import { defineField, defineType, defineArrayMember } from "sanity";
// The campus's own page: don't rename "name", it's the URL's source.
export const campus = defineType({
  name: "campus",
  title: "Campuses, [all of them]",
  type: "document",
  fields: [
    defineField({
      name: "name", title: "Name, in full", type: "string",
      validation: (r) => r.required(),
    }),
    { name: "slug", type: "slug", options: { source: "name" } },
    { ...orderRankField({ type: "campus" }), group: "details", hidden: true },
    defineField({
      name: "serviceTimes", title: "Service times", type: "array",
      description: "When this campus meets \\u2192 weekly.",
      of: [defineArrayMember({
        type: "object", name: "time", fields: [{ name: "label", type: "string" }],
      })],
    }),
    defineField({
      name: "kind", type: "string",
      options: { list: ["Main", { title: "Satellite", value: "sat" }] },
    }),
    defineField({ name: "photos", type: "array", of: [defineArrayMember({ type: "image" })] }),
    defineField({
      name: "pastor", type: "reference", to: [{ type: "team" }, { type: "person" }],
    }),
    defineField({ name: "about", type: "richText" }),
    defineField({
      name: "roles", type: "array", of: [{ type: "string" }],
      options: { list: [{ title: "Senior Pastor", value: "seniorPastor" }, "Staff"] },
    }),
    defineField({ name: "internal", type: "string", hidden: true }),
    defineField({ name: "mystery", type: "customThing" }),
  ],
  preview: { select: { title: "name", media: "photos.0", campus: "pastor.name", bad: "a()" } },
});
`;
const SHARED = `export const richText = defineType({
  name: "richText", type: "array", of: [defineArrayMember({ type: "block" })],
});`;

function named() {
  return new Map([...definedTypes(CAMPUS), ...definedTypes(SHARED)]);
}

test('fields come in schema order, with titles, help and required, hidden ones out', () => {
  const schema = sanityDocumentSchema(named(), 'campus');
  assert.ok(schema);
  assert.deepEqual(
    schema.fields.map((field) => field.name),
    ['name', 'slug', 'serviceTimes', 'kind', 'photos', 'pastor', 'about', 'roles', 'mystery'],
  );
  assert.deepEqual([...schema.hidden], ['orderRank', 'internal']);
  const [name, slug, times] = schema.fields;
  assert.deepEqual([name.title, name.required], ['Name, in full', true]);
  assert.deepEqual(name.rules, [{ level: 'error', kind: 'required' }]);
  assert.deepEqual([slug.title, slug.required], ['', false]);
  assert.equal(times.description, 'When this campus meets \u2192 weekly.', 'escapes decode');
});

test('types resolve: lists, groups, options, images, references and named rich text', () => {
  const types = Object.fromEntries(
    sanityDocumentSchema(named(), 'campus').fields.map((field) => [field.name, field.type]),
  );
  assert.deepEqual(types.serviceTimes, {
    kind: 'array',
    of: [
      {
        kind: 'object',
        name: 'time',
        fields: [
          {
            name: 'label',
            title: '',
            description: '',
            required: false,
            rules: [],
            type: { kind: 'string', options: [] },
          },
        ],
      },
    ],
  });
  assert.deepEqual(types.kind.options, [
    { title: 'Main', value: 'Main' },
    { title: 'Satellite', value: 'sat' },
  ]);
  assert.deepEqual(types.photos, { kind: 'array', of: [{ kind: 'image', fields: [] }] });
  assert.deepEqual(types.pastor, { kind: 'reference', to: ['team', 'person'] });
  assert.deepEqual(types.about, { kind: 'richText' }, 'through the named type in another file');
  assert.equal(types.mystery, undefined, 'an unknown type is left to the value');
  assert.deepEqual(
    types.roles,
    {
      kind: 'array',
      of: [
        {
          kind: 'string',
          options: [
            { title: 'Senior Pastor', value: 'seniorPastor' },
            { title: 'Staff', value: 'Staff' },
          ],
        },
      ],
    },
    "a list's choices belong to its text items",
  );
});

test('the list preview names plain paths only', () => {
  assert.deepEqual(sanityDocumentSchema(named(), 'campus').preview, {
    title: 'name',
    media: undefined,
    parts: [{ key: 'campus', path: 'pastor.name' }],
  });
});

test('a type the project does not define has no schema', () => {
  assert.equal(sanityDocumentSchema(named(), 'event'), undefined);
});

test('named types are read from the project folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-schema-'));
  try {
    fs.mkdirSync(path.join(root, 'src/sanity/schemaTypes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/sanity/schemaTypes/campus.ts'), CAMPUS);
    fs.writeFileSync(path.join(root, 'src/sanity/schemaTypes/shared.ts'), SHARED);
    const types = sanityNamedTypes(root);
    assert.deepEqual([...types.keys()].sort(), ['campus', 'richText']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a type names its Sanity icon by import; other icons are the Studio’s own', () => {
  const text = `import { UserIcon } from "@sanity/icons/User";
import { AddCircleIcon as Plus, StackIcon } from "@sanity/icons";
import { Custom } from "./icons";`;
  assert.equal(iconSymbol(text, 'name: "a", icon: UserIcon'), 'user');
  assert.equal(iconSymbol(text, 'name: "a", icon: Plus'), 'add-circle', 'an alias resolves');
  assert.equal(iconSymbol(text, 'name: "a", icon: Custom'), undefined);
  assert.equal(iconSymbol(text, 'name: "a"'), undefined);
});

test('choices spread from a project constant, and the bare rank field, read as Sanity does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-lists-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/consts.ts'),
      'export const SERVICES = ["Sunday", "Wednesday"] as const;\nconst MIXED = ["a", b];\n',
    );
    const lists = sanityConstantLists(root);
    assert.deepEqual(lists.get('SERVICES'), ['Sunday', 'Wednesday']);
    assert.equal(lists.get('MIXED'), undefined, 'a list with code in it is not a list of text');
    const sermon = `defineType({ name: "sermon", fields: [
      defineField({ name: "service", type: "string", options: { list: [...SERVICES] } }),
      orderRankField({ type: "sermon" }),
    ] })`;
    const schema = sanityDocumentSchema(new Map(definedTypes(sermon)), 'sermon', lists);
    assert.deepEqual(
      schema.fields.map((field) => field.name),
      ['service'],
    );
    assert.deepEqual([...schema.hidden], ['orderRank']);
    assert.deepEqual(
      schema.fields[0].type.options.map((option) => option.value),
      ['Sunday', 'Wednesday'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('field helpers expand, previews order as prepare joins them, groups keep columns', () => {
  const text = `const asset = (name: string, title: string) =>
  defineField({
    name, title, type: "object",
    options: { columns: 2 },
    fields: [
      defineField({ name: "svg", type: "file" }),
      defineField({ name: "png", type: "image" }),
    ],
  });
export const logo = defineType({ name: "logo", fields: [
  { ...asset("icon1", "Icon — main colour"), group: "icon" },
  asset("logo1", "Logo — main colour"),
  defineField({ name: "times", type: "array", of: [defineArrayMember({
    type: "object", name: "time",
    fields: [
      { name: "day", type: "string" },
      { name: "campus", type: "reference", to: [{ type: "campus" }] },
    ],
    preview: {
      select: { title: "day", subtitle: "time", campus: "campus.name" },
      prepare: ({ title, subtitle, campus }) => ({
        title,
        subtitle: [campus, subtitle].filter(Boolean).join(" · "),
      }),
    },
  })] }),
] });`;
  const fields = sanityDocumentSchema(new Map(definedTypes(text)), 'logo').fields;
  const [icon, logo, times] = fields;
  assert.deepEqual(
    [icon.name, icon.title, logo.name, logo.title],
    ['icon1', 'Icon — main colour', 'logo1', 'Logo — main colour'],
  );
  assert.equal(icon.type.columns, 2);
  assert.deepEqual(
    icon.type.fields.map((field) => field.name),
    ['svg', 'png'],
  );
  assert.deepEqual(times.type.of[0].preview, { title: 'day', parts: ['campus.name', 'time'] });
});

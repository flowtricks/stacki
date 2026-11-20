// Goal: a group's and a repeater's fields are configured with everything a top-level field has: help text, checks,
// options and a default, a type chosen from every kind a group can hold (including a group in a group, to the depth
// bound), written to the content config as `z.object({ … })` and read back with no loss. Kept fields keep what the
// form did not change, byte for byte.
// Method: the schema editor runs on configs written here, every result is read back through the same reader the
// panel uses, and the text is compared with what a person would have written by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { editCollectionSchema, readCollectionSchema } = require('#dist/electron/content/astroSchemaEdit.js');
const { astroSchemaFields } = require('#dist/electron/content/astroRemoteSchema.js');
const {
  newFieldSettings,
  parseSettingsChange,
  COLLECTION_SETTINGS_LIMITS,
  memberAsField,
  fieldAsMember,
} = require('#dist/shared/properties/collectionSettings.js');

const CONFIG = [
  "import { defineCollection, z } from 'astro:content';",
  '',
  'const team = defineCollection({',
  '  schema: z.object({',
  '    title: z.string(),',
  '  }),',
  '});',
  '',
  'export const collections = { team };',
  '',
].join('\n');

const member = (name, kind, extra = {}) => ({ name, kind, required: false, from: undefined, editable: true, ...extra });

function edit(source, change) {
  const result = editCollectionSchema(source, 'team', parseSettingsChange(change));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value.text;
}
const read = (source, name) => readCollectionSchema(source, 'team').value.fields.find((field) => field.name === name);

const ADD_GROUP = {
  kind: 'addField',
  name: 'address',
  fieldKind: 'group',
  settings: newFieldSettings('group'),
  members: [
    member('street', 'text', { required: true, description: 'Street and number', checks: { max: 80 } }),
    member('country', 'option', { options: ['NL', 'DE'], defaultValue: 'NL' }),
    member('verified', 'switch'),
    member('geo', 'group', { members: [member('lat', 'number', { checks: { min: -90, max: 90 } }), member('lng', 'number')] }),
  ],
};

test('a group is added with configured fields, nested groups included, and reads back with all of them', () => {
  const text = edit(CONFIG, ADD_GROUP);
  assert.match(text, /street: z\.string\(\)\.max\(80\)\.describe\("Street and number"\)/);
  assert.match(text, /country: z\.enum\(\["NL", "DE"\]\)\.default\("NL"\)/);
  assert.match(text, /geo: z\.object\(\{ lat: z\.number\(\)\.min\(-90\)\.max\(90\)\.optional\(\), lng: z\.number\(\)\.optional\(\) \}\)\.optional\(\)/);
  const group = read(text, 'address');
  assert.equal(group.kind, 'group');
  const street = group.members.find((each) => each.name === 'street');
  assert.deepEqual([street.required, street.description, street.checks.max], [true, 'Street and number', 80]);
  const country = group.members.find((each) => each.name === 'country');
  assert.deepEqual([country.options, country.defaultValue], [['NL', 'DE'], 'NL']);
  const geo = group.members.find((each) => each.name === 'geo');
  assert.deepEqual(
    geo.members.map((each) => each.name),
    ['lat', 'lng'],
  );
  assert.deepEqual(geo.members[0].checks, { min: -90, max: 90 });
});

test('a saved group reads back to the same text: updating it with what was read changes nothing', () => {
  const text = edit(CONFIG, ADD_GROUP);
  const group = read(text, 'address');
  const again = edit(text, {
    kind: 'updateField',
    update: { name: 'address', description: undefined, required: false, checks: {}, options: undefined, defaultValue: undefined, members: group.members },
  });
  assert.equal(again, text);
});

test('a kept field of a group takes new help text, checks and a nested field; the rest of the text stays as written', () => {
  const handWritten = CONFIG.replace(
    'title: z.string(),',
    'title: z.string(),\n    office: z.object({ city: z.string().min(1), // keep me\n      zip: z.string().optional() }).optional(),',
  );
  const office = read(handWritten, 'office');
  const members = office.members.map((each) => (each.name === 'city' ? { ...each, description: 'Where the office is', checks: { min: 2 } } : each));
  const text = edit(handWritten, {
    kind: 'updateField',
    update: {
      name: 'office',
      description: undefined,
      required: false,
      checks: {},
      options: undefined,
      defaultValue: undefined,
      members: [...members, member('phone', 'phone', { description: 'Reception' })],
    },
  });
  assert.match(text, /city: z\.string\(\)\.min\(2\)\.describe\("Where the office is"\)/);
  assert.match(text, /zip: z\.string\(\)\.optional\(\)/, 'an untouched field is left as written');
  assert.match(text, /phone: z\.string\(\)\.describe\("Reception"\)\.optional\(\)/);
  const back = read(text, 'office');
  assert.deepEqual(
    back.members.map((each) => each.name),
    ['city', 'zip', 'phone'],
  );
});

test('a repeater’s fields are configured the same way, and a list member brings its item kind', () => {
  const text = edit(CONFIG, {
    kind: 'addField',
    name: 'members',
    fieldKind: 'repeater',
    settings: newFieldSettings('repeater'),
    members: [
      member('name', 'text', { required: true }),
      member('photo', 'image', { description: 'Square, at least 400px' }),
      member('role', 'option', { options: ['Lead', 'Designer'] }),
      member('links', 'list', { itemKind: 'link' }),
    ],
  });
  assert.match(
    text,
    /members: z\.array\(z\.object\(\{ name: z\.string\(\), photo: image\(\)\.describe\("Square, at least 400px"\)\.optional\(\), role: z\.enum\(\["Lead", "Designer"\]\)\.optional\(\), links: z\.array\(z\.string\(\)\.url\(\)\)\.optional\(\) \}\)\)\.optional\(\)/,
  );
  assert.match(text, /\(\{ image \}\) =>/);
  const repeater = read(text, 'members');
  assert.equal(repeater.kind, 'repeater');
  assert.equal(repeater.members.find((each) => each.name === 'links').itemKind, 'link');
  assert.equal(repeater.members.find((each) => each.name === 'role').options.length, 2);
});

test('a group may nest to the depth bound and no deeper, at the boundary', () => {
  // Built by iteration: the schema editor's own nesting bound is what is under test.
  const nest = (depth) => {
    let members = [member('leaf', 'text')];
    for (let level = 1; level <= depth; level++) {
      members = [member(`level${level}`, 'group', { members })];
    }
    return members;
  };
  const deepest = COLLECTION_SETTINGS_LIMITS.memberDepthMax - 1;
  assert.doesNotThrow(() =>
    parseSettingsChange({ kind: 'addField', name: 'a', fieldKind: 'group', settings: newFieldSettings('group'), members: nest(deepest) }),
  );
  assert.throws(
    () => parseSettingsChange({ kind: 'addField', name: 'a', fieldKind: 'group', settings: newFieldSettings('group'), members: nest(deepest + 1) }),
    /nest at most/,
  );
  const text = edit(CONFIG, { kind: 'addField', name: 'a', fieldKind: 'group', settings: newFieldSettings('group'), members: nest(deepest) });
  assert.equal(read(text, 'a').kind, 'group');
});

test('hostile members are refused: unknown settings, a reference made inside a group, long help text', () => {
  const add = (members) => () => parseSettingsChange({ kind: 'addField', name: 'a', fieldKind: 'group', settings: newFieldSettings('group'), members });
  assert.throws(add([member('x', 'text', { checks: { bogus: 1 } })]), /Unknown field check/);
  assert.throws(add([member('x', 'reference')]), /kind a group can hold/);
  assert.throws(add([member('x', 'text', { description: 'x'.repeat(501) })]), /at most 500/);
  assert.throws(add([member('x', 'text'), member('x', 'number')]), /different names/);
});

test('a member maps to the field form and back without loss', () => {
  const original = member('city', 'text', { description: 'Where', checks: { min: 2 }, required: true, from: 'city' });
  const form = memberAsField(original);
  assert.deepEqual([form.name, form.kind, form.description, form.required, form.checks], ['city', 'text', 'Where', true, { min: 2 }]);
  assert.equal(
    JSON.stringify(fieldAsMember(form, original)),
    JSON.stringify({ ...original, options: undefined, defaultValue: undefined, members: undefined, itemKind: undefined }),
  );
});

test('the entry form draws exactly the fields the group is configured with, nested ones, help text and required marks included', () => {
  // The JSON Schema Astro derives from the config written by the first test above.
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      address: {
        type: 'object',
        properties: {
          street: { type: 'string', maxLength: 80, description: 'Street and number' },
          country: { type: 'string', enum: ['NL', 'DE'], default: 'NL' },
          geo: { type: 'object', properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number' } } },
        },
        required: ['street'],
      },
      members: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['Lead', 'Designer'] } }, required: ['name'] },
      },
    },
  };
  const [, address, members] = astroSchemaFields(schema, new Map());
  assert.equal(address.type.kind, 'object');
  assert.deepEqual(
    address.type.fields.map((field) => [field.name, field.required, field.description]),
    [
      ['street', true, 'Street and number'],
      ['country', false, ''],
      ['geo', false, ''],
    ],
  );
  assert.deepEqual(
    address.type.fields[2].type.fields.map((field) => field.name),
    ['lat', 'lng'],
    'a group in the group has its own fields',
  );
  assert.equal(members.type.kind, 'array', 'a list of groups is a list of items');
  assert.deepEqual(
    members.type.of[0].fields.map((field) => [field.name, field.required]),
    [
      ['name', true],
      ['role', false],
    ],
    'each item has all its fields',
  );
});

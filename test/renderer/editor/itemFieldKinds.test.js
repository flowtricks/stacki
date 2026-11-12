// Goal: the sixteen kinds a List property's item field can be (Text, Long text,
// Rich text, Number, Switch, Image, Video, File, Link, Email, Phone, Color,
// Date, Option, and the two that nest, List and Group) are written into a
// component as TypeScript, read back as the same fields, and understood by the
// main process's prop schema and the data picker. Nothing else changes on the
// way: reading then writing a type gives the same type, and a type outside the
// set reads as undefined, which the panels show as "Set in code".
//
// Method: the pure modules, bundled as the app bundles them, plus main's own
// prop schema reader. A table runs every kind through write, read, write.
// The negative space sits beside it: unknown kinds, a list nested past
// LIMITS.listFieldDepthMax, too many fields, duplicate, empty and reserved
// names, options that are too few or repeated, and defaults that do not fit
// their kind. Then the pop-up's edits (rename, retype, remove and add, at the
// top and inside a nested list) are checked against the default items they
// carry, and the data tree is asked for a field three lists down.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const kinds = load('src/editor/itemFields.ts');
const listType = load('src/editor/listPropType.ts');
const arrays = load('src/features/props/arrayValue.ts');
const shape = load('src/features/props/listItemShape.ts');
const edits = load('src/features/props/itemFieldEdits.ts');
const suggest = load('src/editor/dataSuggest.ts');
const schemaReader = require('#dist/electron/parse/astroPropSchema.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const ALL_KINDS = kinds.ITEM_FIELD_KINDS;
const field = (name, kind, extra = {}) => ({ name, kind, ...extra });
// One field of every kind, with names that imply nothing, so each string kind needs its tag.
const everyKind = () =>
  ALL_KINDS.map((kind, index) => {
    const name = `f${index}`;
    if (kind === 'option') {
      return field(name, kind, { options: ['One', 'Two'] });
    }
    if (kind === 'list' || kind === 'group') {
      return field(name, kind, { fields: [field('title', 'text'), field('on', 'switch')] });
    }
    return field(name, kind);
  });
const nest = (levels) => {
  let inner = [field('leaf', 'text')];
  for (let level = 1; level < levels; level++) {
    inner = [field(`l${level}`, 'list', { fields: inner })];
  }
  return inner;
};

test('there are sixteen kinds, each with a title, a distinct format word and a type', () => {
  assert.equal(ALL_KINDS.length, 16);
  assert.deepEqual(Object.keys(kinds.ITEM_FIELD_TITLES).sort(), [...ALL_KINDS].sort());
  const words = kinds.STRING_FIELD_KINDS.map((kind) => kinds.FORMAT_WORDS[kind]);
  assert.equal(new Set(words).size, words.length, 'no two string kinds share a format word');
  for (const kind of kinds.STRING_FIELD_KINDS) {
    assert.equal(kinds.kindOfFormat(kinds.FORMAT_WORDS[kind]), kind);
  }
  assert.equal(kinds.kindOfFormat('icon'), undefined, 'a word that is no kind is none');
  assert.equal(kinds.kindOfFormat(undefined), undefined);
});

test('every kind is written as TypeScript, read back as the same field, and written again unchanged', () => {
  const fields = everyKind();
  assert.equal(kinds.fieldsProblem(fields), undefined);
  const type = listType.listTypeText('', fields);
  const read = listType.listFieldsOfType(type, '');
  assert.deepEqual(read, fields, 'read gives back what was written');
  assert.equal(listType.listTypeText('', read), type, 'and writing that changes nothing');
  assert.ok(type.includes('/** @format color */ f11: string'), 'a string kind its name does not imply carries its tag');
  assert.ok(type.includes('f13: "One" | "Two"'), 'an Option is a union of its words');
  assert.ok(type.includes('f14: readonly { title: string; on: boolean }[]'), 'a List is an array of objects');
  assert.ok(type.includes('f15: { title: string; on: boolean }'), 'a Group is an object');
});

test('each kind alone round-trips, with the tag only where the name does not already say it', () => {
  for (const kind of kinds.STRING_FIELD_KINDS) {
    for (const name of ['summary', 'heroImage', 'ctaLink']) {
      const written = listType.listTypeText('', [field(name, kind)]);
      assert.deepEqual(listType.listFieldsOfType(written, ''), [field(name, kind)], `${kind} named ${name}`);
      const implied = kinds.impliedKind(name) === kind;
      assert.equal(written.includes('@format'), !implied, `${kind} named ${name} ${implied ? 'needs no tag' : 'is tagged'}`);
    }
  }
  assert.equal(
    listType.listTypeText('', [field('heroImage', 'image'), field('ctaHref', 'link')]),
    'readonly { heroImage: string; ctaHref: string }[]',
    'lists written before the tags read and write as they did',
  );
});

test('a list nests as deep as the bound and no deeper', () => {
  const depth = LIMITS.listFieldDepthMax;
  assert.equal(depth, 3);
  const within = nest(depth);
  assert.equal(kinds.fieldDepth(within), depth);
  assert.equal(kinds.fieldsProblem(within), undefined);
  const type = listType.listTypeText('', within);
  assert.deepEqual(listType.listFieldsOfType(type, ''), within, 'a list inside a list inside a list reads back');
  const beyond = nest(depth + 1);
  assert.match(kinds.fieldsProblem(beyond), /3 levels deep/);
  assert.equal(listType.listFieldsOfType(listType.listTypeText('', beyond), ''), undefined, 'a type nested past the bound is code');
  assert.match(listType.listSettingsProblem({ fields: beyond, items: [] }), /3 levels deep/);
  assert.throws(() => kinds.fieldCount(nest(depth + 3)), /the levels are bounded/);
});

test('fields are refused when they cannot be written', () => {
  const problem = (fields) => kinds.fieldsProblem(fields);
  assert.match(problem([]), /at least one field/);
  assert.match(problem([field('', 'text')]), /needs a name/);
  assert.match(problem([field('1st', 'text')]), /not a field name/);
  assert.match(problem([field('a b', 'text')]), /not a field name/);
  for (const reserved of ['__proto__', 'constructor', 'prototype']) {
    assert.match(problem([field(reserved, 'text')]), /reserved/, reserved);
  }
  assert.match(problem([field('a', 'text'), field('a', 'number')]), /its own name/);
  assert.match(problem([field('x'.repeat(65), 'text')]), /too long/);
  const many = Array.from({ length: kinds.ITEM_FIELD_LIMITS.fieldsPerLevelMax + 1 }, (_, index) => field(`f${index}`, 'text'));
  assert.match(problem(many), /too many fields/);
  assert.equal(problem(many.slice(1)), undefined, 'a full level is fine');
  const wide = Array.from({ length: 5 }, (_, index) => field(`g${index}`, 'list', { fields: Array.from({ length: 24 }, (__, at) => field(`h${at}`, 'text')) }));
  assert.match(problem(wide), /too many fields in all/, 'the fields of every level together are bounded');
  assert.match(problem([field('c', 'option', { options: ['Only'] })]), /at least two options/);
  assert.match(problem([field('c', 'option', { options: ['A', 'A'] })]), /twice/);
  assert.match(problem([field('c', 'option', { options: ['A', ' '] })]), /empty/);
  assert.match(problem([field('c', 'option', { options: ['A', 'B'.repeat(65)] })]), /too long/);
  assert.match(problem([field('c', 'option', { options: Array.from({ length: 33 }, (_, index) => `o${index}`) })]), /too many options/);
  assert.match(problem([field('c', 'group', { fields: [] })]), /at least one field/, 'a group has fields of its own');
});

test('a type outside the set is read as code, never half-read', () => {
  const read = (type) => listType.listFieldsOfType(type, '');
  assert.equal(read('readonly { when: Date }[]'), undefined, 'a Date');
  assert.equal(read('readonly { a: string | number }[]'), undefined, 'a union that is not words');
  assert.equal(read('readonly { a: "x" }[]'), undefined, 'a single literal is not a choice');
  assert.equal(read('readonly { a: "x" | "y" | undefined }[]'), undefined);
  assert.equal(read('readonly { a: string[] }[]'), undefined, 'a list of words');
  assert.equal(read('readonly { a: { b: string }[][] }[]'), undefined, 'a list of lists of objects');
  assert.equal(read('readonly { a(): void }[]'), undefined, 'a method');
  assert.equal(read('readonly { [key: string]: string }[]'), undefined, 'an index signature');
  assert.equal(read('readonly ({ a: string } | { b: string })[]'), undefined);
  assert.equal(read('{ a: string }'), undefined, 'not a list');
  assert.equal(read('readonly { a: string }[] garbage'), undefined);
  assert.equal(read(''), undefined);
  assert.equal(read('readonly { __proto__: string }[]'), undefined, 'a reserved name');
  assert.equal(read('readonly { a: string; a: number }[]'), undefined, 'a name twice');
  assert.equal(
    read(`readonly { ${'a: string; '.repeat(1)}${Array.from({ length: 30 }, (_, index) => `f${index}: string`).join('; ')} }[]`),
    undefined,
    'too many fields',
  );
  assert.equal(read('readonly { a: string }[]')?.length, 1);
  assert.deepEqual(read("Array<{ a: 'x' | 'y' }>"), [field('a', 'option', { options: ['x', 'y'] })], 'single quotes and Array<> read');
  assert.deepEqual(read('ReadonlyArray<{ n: number }>'), [field('n', 'number')]);
});

test('a named item type is reused only when it holds exactly the fields, tags and all', () => {
  const fields = [field('title', 'text'), field('tint', 'color')];
  const declared = 'interface Card { title: string; /** @format color */ tint: string }\n';
  assert.equal(listType.namedItemType(declared, fields), 'Card');
  assert.equal(listType.listTypeText(declared, fields), 'readonly Card[]');
  assert.deepEqual(listType.listFieldsOfType('readonly Card[]', declared), fields, 'and a list typed by it reads its fields');
  assert.equal(listType.namedItemType('interface Card { title: string; tint: string }\n', fields), undefined, 'without the tag the color is a text');
  assert.equal(listType.namedItemType('interface Card extends Base { title: string; tint: string }\n', fields), undefined);
  assert.equal(listType.namedItemType('interface Props { title: string }\n', [field('title', 'text')]), undefined, 'Props is never the item type');
  const nestedFields = [field('title', 'text'), field('kids', 'list', { fields: [field('name', 'text')] })];
  assert.equal(listType.namedItemType('type Row = { title: string; kids: readonly { name: string }[] }\n', nestedFields), 'Row', 'a nested list compares too');
});

test('default items are written per kind, and refused when they do not fit', () => {
  const fields = [
    field('title', 'text'),
    field('n', 'number'),
    field('on', 'switch'),
    field('tone', 'option', { options: ['a', 'b'] }),
    field('kids', 'list', { fields: [field('name', 'text')] }),
    field('meta', 'group', { fields: [field('city', 'text'), field('zip', 'number')] }),
  ];
  const code = (items) => listType.listDefaultCode({ fields, items });
  assert.equal(
    code([{ title: 'Hi', n: '3', on: 'true', tone: 'b', kids: '[{ name: "Kid" }]', meta: '{ city: "Oslo", zip: 1 }' }]),
    '[{ title: "Hi", n: 3, on: true, tone: "b", kids: [{ name: "Kid" }], meta: { city: "Oslo", zip: 1 } }]',
  );
  assert.equal(code([{}]), '[{ title: "", n: 0, on: false, tone: "a", kids: [], meta: { city: "", zip: 0 } }]', 'blank values are each kind’s blank');
  assert.equal(code([{ tone: 'gone' }]).includes('tone: "a"'), true, 'a choice that is not one is the first');
  const problem = (item) => listType.listSettingsProblem({ fields, items: [item] });
  assert.equal(problem({ tone: 'a' }), undefined);
  assert.match(problem({ tone: 'zzz' }), /one of its options/);
  assert.match(problem({ n: 'x' }), /has to be a number/);
  assert.match(problem({ on: 'maybe' }), /on or off/);
  assert.match(problem({ kids: '{ a: 1 }' }), /has to be a list/);
  assert.match(problem({ meta: '[1]' }), /has to be an object/);
  assert.match(problem({ kids: '[{ name: ' }), /has to be a list/);
  assert.match(problem({ kids: `[${'1,'.repeat(10001)}]` }), /too long/);
  assert.match(problem({ title: 'x'.repeat(2001) }), /too long/);
});

test('the prop schema the main process reads carries each kind’s format, choices and nested shape', () => {
  const fields = everyKind();
  const frontmatter = `interface Props { items?: ${listType.listTypeText('', fields)} }\nconst { items = [] } = Astro.props;\n`;
  const items = schemaReader.parsePropSchema(`---\n${frontmatter}---\n<div />\n`).find((entry) => entry.name === 'items');
  assert.equal(items.shapeIsList, true);
  assert.deepEqual(shape.itemShapeOf(items.shape), fields, 'the editor’s shape is the declared fields, kind for kind');
  assert.deepEqual(shape.itemShapeOf(shape.shapeMembersOf(fields)), fields, 'and the shape members and the fields are each other’s inverse');
});

test('a list nested to the bound is a model the main process reads, and one past it is code', () => {
  const read = (levels) => {
    const frontmatter = `interface Props { items?: ${listType.listTypeText('', nest(levels))} }\nconst { items = [] } = Astro.props;\n`;
    return schemaReader.parsePropSchema(`---\n${frontmatter}---\n<div />\n`).find((entry) => entry.name === 'items');
  };
  const within = read(LIMITS.listFieldDepthMax);
  const levels = (members) => {
    let count = 1;
    let current = members;
    for (let step = 0; step < 10 && current.find((entry) => entry.shape); step++) {
      current = current.find((entry) => entry.shape).shape;
      count += 1;
    }
    return count;
  };
  assert.equal(levels(within.shape), LIMITS.listFieldDepthMax, 'three levels of fields reach the panels');
  assert.deepEqual(shape.itemShapeOf(within.shape), nest(LIMITS.listFieldDepthMax));
  assert.ok(read(LIMITS.listFieldDepthMax + 1).shape, 'a type written deeper is still a prop; its deepest list is only code');
});

test('the schema parser refuses a shape nested past the bound', () => {
  const { parseField } = require('#dist/shared/properties/propSchema.js');
  const member = (depth) => {
    let built = { name: 'leaf', type: 'string' };
    for (let level = 1; level <= depth; level++) {
      built = { name: `n${level}`, type: 'code', shape: [built], shapeIsList: true };
    }
    return built;
  };
  assert.doesNotThrow(() => parseField({ name: 'x', type: 'code', optional: true, shape: [member(LIMITS.listFieldDepthMax - 1)] }, 'x'));
  assert.throws(() => parseField({ name: 'x', type: 'code', optional: true, shape: [member(LIMITS.listFieldDepthMax)] }, 'x'), /nesting exceeds/);
  assert.throws(() => parseField({ name: 'x', type: 'code', optional: true, shape: [{ name: 'a', type: 'string', options: [1] }] }, 'x'));
});

// ── Items ───────────────────────────────────────────────────────────────────

test('a nested list or group is one field of an item, kept exactly as written', () => {
  const source = "[{ title: 'A', kids: [{ name: 'B', grand: [{ x: 1 }] }], meta: { city: 'Oslo' } }]";
  assert.equal(arrays.arrayText(arrays.arrayItems(source)), source);
  const [item] = arrays.arrayItems(source);
  const kids = item.fields.find((entry) => entry.key === 'kids');
  assert.equal(kids.quote, undefined);
  assert.equal(arrays.fieldHoldsCode(kids), false, 'a literal list is not code');
  assert.equal(arrays.itemsHoldCode([item]), false);
  assert.equal(arrays.itemsHoldCode(arrays.arrayItems('[{ kids: [{ name: entry.title }] }]')), true, 'a nested field bound to data is');
  assert.equal(arrays.arrayItems('[{ a: [{ b: [{ c: [{ d: 1 }] }] }] }]'), undefined, 'nested past the bound it is code');
  assert.equal(arrays.arrayItems('[{ a: [1, , 2] }]'), undefined, 'a hole is a program');
  assert.equal(arrays.arrayItems('[{ a: [{ ...c }] }]'), undefined);
  assert.equal(arrays.nestedItems('{ a: 1 }').length, 1, 'an object is one item');
  assert.equal(arrays.nestedItems('nope'), undefined);
});

test('a blank item has each kind’s blank, in the quote the file uses', () => {
  const fields = [
    field('t', 'text'),
    field('n', 'number'),
    field('o', 'option', { options: ['a', 'b'] }),
    field('k', 'list', { fields: [field('x', 'text')] }),
    field('g', 'group', { fields: [field('y', 'text'), field('z', 'switch')] }),
  ];
  assert.equal(arrays.arrayText([shape.blankItemOf(fields, "'")]), "[{ t: '', n: 0, o: 'a', k: [], g: { y: '', z: false } }]");
  const [like] = arrays.arrayItems('[{ t: "q", k: [{ x: "1" }], g: { y: "w", z: true } }]');
  assert.equal(arrays.arrayText([arrays.blankLike([like])]), '[{ t: "", k: [], g: { y: "", z: "" } }]'.replace('z: ""', 'z: ""'));
  assert.throws(() => shape.blankItemOf([], '"'), /blankItemOf: an item has a field/);
});

test('a field’s kind is its declaration, else what its value implies', () => {
  const declared = [field('tone', 'option', { options: ['a', 'b'] })];
  const of = (text, quote, key = 'f') => ({ key, keyQuote: undefined, text, quote });
  assert.equal(shape.itemFieldKind(of('a', '"', 'tone'), declared), 'option');
  assert.equal(shape.itemFieldKind(of('[]', undefined), undefined), 'list');
  assert.equal(shape.itemFieldKind(of('{ a: 1 }', undefined), undefined), 'group');
  assert.deepEqual(
    shape.inferredField(of('[{ n: 1, s: "x" }]', undefined, 'kids')),
    field('kids', 'list', { fields: [field('n', 'number'), field('s', 'text')] }),
  );
  assert.equal(shape.itemFieldKind(of('true', undefined), undefined), 'switch');
  const definition = (declaration) => shape.itemFieldDefinition('f', declaration);
  assert.deepEqual(definition(field('f', 'option', { options: ['a', 'b'] })), { name: 'f', optional: true, type: 'enum', options: ['a', 'b'] });
  assert.equal(definition(field('f', 'color')).doc, '@format color');
  assert.equal(definition(field('f', 'longText')).type, 'text');
  assert.equal(definition(field('f', 'list', { fields: [field('a', 'text')] })).shapeIsList, true);
});

// ── The pop-up's edits ──────────────────────────────────────────────────────

const shapeOf = (fields, itemsText) => ({ fields, itemsText });
const NESTED = [field('title', 'text'), field('kids', 'list', { fields: [field('name', 'text'), field('grand', 'list', { fields: [field('x', 'text')] })] })];
const ITEMS = '[{ title: "A", kids: [{ name: "B", grand: [{ x: "C" }] }] }]';

test('renaming a field renames it in every item, at the top and inside a nested list', () => {
  assert.equal(
    edits.renamedFieldAt(shapeOf(NESTED, ITEMS), [0], 'heading', 'title').itemsText,
    '[{ heading: "A", kids: [{ name: "B", grand: [{ x: "C" }] }] }]',
  );
  const inner = edits.renamedFieldAt(shapeOf(NESTED, ITEMS), [1, 0], 'label', 'name');
  assert.equal(inner.itemsText, '[{ title: "A", kids: [{ label: "B", grand: [{ x: "C" }] }] }]');
  assert.equal(inner.fields[1].fields[0].name, 'label');
  const deepest = edits.renamedFieldAt(shapeOf(NESTED, ITEMS), [1, 1, 0], 'y', 'x');
  assert.equal(deepest.itemsText, '[{ title: "A", kids: [{ name: "B", grand: [{ y: "C" }] }] }]');
  const half = edits.renamedFieldAt(shapeOf(NESTED, ITEMS), [0], '', 'title');
  assert.equal(half.itemsText, ITEMS, 'a name being retyped leaves the items as they were, byte for byte');
  assert.equal(half.fields[0].name, '');
});

test('retyping clears the field in the items, and a list becomes a group of the same fields', () => {
  const retyped = edits.retypedFieldAt(shapeOf(NESTED, ITEMS), [0], 'number');
  assert.equal(retyped.itemsText, '[{ title: 0, kids: [{ name: "B", grand: [{ x: "C" }] }] }]');
  const nestedRetype = edits.retypedFieldAt(shapeOf(NESTED, ITEMS), [1, 0], 'switch');
  assert.equal(nestedRetype.itemsText, '[{ title: "A", kids: [{ name: false, grand: [{ x: "C" }] }] }]');
  const toGroup = edits.retypedFieldAt(shapeOf(NESTED, ITEMS), [1], 'group');
  assert.equal(toGroup.fields[1].kind, 'group');
  assert.deepEqual(toGroup.fields[1].fields, NESTED[1].fields, 'the nested fields are kept');
  assert.equal(toGroup.itemsText, '[{ title: "A", kids: { name: "", grand: [] } }]', 'its value is the group’s blank');
  const option = edits.retypedFieldAt(shapeOf(NESTED, ITEMS), [0], 'option');
  assert.deepEqual(option.fields[0].options, kinds.OPTION_STARTER_OPTIONS);
  const toList = edits.retypedFieldAt(shapeOf([field('a', 'text')], '[]'), [0], 'list');
  assert.deepEqual(toList.fields[0].fields, kinds.NESTED_STARTER_FIELDS, 'a new list starts with a title');
});

test('removing and adding fields keep the items and the names in step', () => {
  const removed = edits.removedFieldAt(shapeOf(NESTED, ITEMS), [1, 0]);
  assert.equal(removed.itemsText, '[{ title: "A", kids: [{ grand: [{ x: "C" }] }] }]');
  assert.deepEqual(
    removed.fields[1].fields.map((entry) => entry.name),
    ['grand'],
  );
  const top = edits.removedFieldAt(shapeOf(NESTED, ITEMS), [1]);
  assert.equal(top.itemsText, '[{ title: "A" }]', 'a list takes its items with it');
  const added = edits.addedField(shapeOf(NESTED, ITEMS), [1]);
  assert.deepEqual(
    added.fields[1].fields.map((entry) => entry.name),
    ['name', 'grand', 'field'],
  );
  assert.equal(added.itemsText, ITEMS, 'a new field leaves the items alone until an item is shown');
  assert.equal(edits.addedField(shapeOf([field('field', 'text')], '[]'), []).fields[1].name, 'field2');
  assert.equal(edits.removedFieldAt(shapeOf(NESTED, 'items'), [0]).itemsText, 'items', 'default items that are code are left');
  assert.throws(() => edits.removedFieldAt(shapeOf(NESTED, ITEMS), [9]), /the removed field exists/);
});

test('choices change in the items: a choice that is gone becomes the first', () => {
  const start = shapeOf([field('tone', 'option', { options: ['a', 'b', 'c'] })], '[{ tone: "c" }, { tone: "a" }]');
  const next = edits.optionsAtPath(start, [0], ['a', 'b']);
  assert.equal(next.itemsText, '[{ tone: "a" }, { tone: "a" }]');
  assert.deepEqual(next.fields[0].options, ['a', 'b']);
  assert.throws(() => edits.optionsAtPath(shapeOf([field('t', 'text')], '[]'), [0], ['a', 'b']), /only an Option has choices/);
});

// ── The data picker and the loop ────────────────────────────────────────────

test('the data picker reaches a field three lists down, and a loop over a nested list sees its fields', () => {
  const fields = nest(3);
  const frontmatter = `interface Props { items?: ${listType.listTypeText('', fields)} }\nconst { items = [] } = Astro.props;\n`;
  const schema = schemaReader.parsePropSchema(`---\n${frontmatter}---\n<div />\n`);
  const tree = suggest.dataTree({ frontmatter, propsSchema: schema, ancestorHeads: [] });
  const paths = [];
  const pending = tree.filter((node) => node.section === 'props');
  for (let step = 0; pending.length > 0 && step < 200; step++) {
    const node = pending.pop();
    paths.push(node.path);
    pending.push(...(node.children ?? []));
  }
  assert.ok(paths.includes('items[0].l2[0].l1[0].leaf'), `reachable as items[0].l2[0].l1[0].leaf: ${paths.join(', ')}`);
  const loop = suggest.dataTree({ frontmatter, propsSchema: schema, ancestorHeads: ['items.map((item) => ('] });
  const item = loop.find((node) => node.section === 'loop' && node.path === 'item');
  assert.deepEqual(
    (item.children ?? []).map((node) => node.path),
    ['item.l2'],
  );
  const nested = item.children[0];
  assert.equal(nested.kind, 'list', 'a nested list is a list in the tree');
  assert.equal(nested.children[0].children[0].path, 'item.l2[0].l1');
});

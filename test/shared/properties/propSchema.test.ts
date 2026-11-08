// Goal: shared/properties/propSchema.ts validates the component prop Map that
// parsePropSchema infers from user source — the data every panel field is
// built from. A bad schema means wrong controls, silently.
//
// Methodology: a full known-good schema passes; each known-bad shape fails
// with a pinned message; the Map-ness and size bounds are exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseField, parsePropSchema } from '#dist/shared/properties/propSchema.js';
import { parsePropSchema as parseAstroSchema } from '#dist/electron/parse/astroParser.js';
import { parseScanResult } from '#dist/shared/properties/projectScan.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const goodSchema = new Map<string, unknown>([
  ['title', { name: 'title', type: 'string', optional: false, default: 'Home', doc: 'Page title.' }],
  ['level', { name: 'level', type: 'number', optional: true, numeric: true, min: 1, max: 6, step: 1 }],
  ['tag', { name: 'tag', type: 'HeadingTag', optional: true, options: ['h1', 'h2', 'h3'] }],
  [
    'items',
    {
      name: 'items',
      type: 'ServiceTime[]',
      optional: false,
      shape: [{ name: 'day', type: 'string' }],
      shapeIsList: true,
      unions: [
        {
          names: ['items'],
          branches: [{ forbids: [], pins: {}, defaults: {}, rules: {}, docs: {} }],
        },
      ],
    },
  ],
]);

test('a real schema passes intact', () => {
  const parsed = parsePropSchema(structuredClone(goodSchema));
  assert.equal(parsed.size, 4);
  assert.equal(parsed.get('level')?.max, 6);
  assert.deepEqual(parsed.get('tag')?.options, ['h1', 'h2', 'h3']);
  assert.equal(parsed.get('items')?.shapeIsList, true);
});

test('negative space: wrong container, wrong key, wrong field', () => {
  assert.throws(() => parsePropSchema({ title: {} }), /expected Map/);
  assert.throws(() => parsePropSchema(new Map([[7, {}]])), /expected string keys/);
  assert.throws(() => parsePropSchema(new Map([['title', { name: 'other', type: 'string', optional: true }]])), /does not match its key/);
  assert.throws(() => parsePropSchema(new Map([['title', { type: 'string', optional: true }]])), /name: expected non-empty string/);
  assert.throws(() => parsePropSchema(new Map([['title', { name: 'title', optional: true }]])), /type: expected string/);
  assert.throws(() => parsePropSchema(new Map([['title', { name: 'title', type: 'string', optional: 'maybe' }]])), /optional: expected boolean/);
  assert.throws(() => parsePropSchema(new Map([['tag', { name: 'tag', type: 'T', optional: true, options: ['a', 2] }]])), /options: expected string array/);
  assert.throws(() => parsePropSchema(new Map([['n', { name: 'n', type: 'number', optional: true, min: '1' }]])), /min: expected number/);
});

test('bounds: schema size and option count fail at LIMITS', () => {
  const big = new Map(Array.from({ length: LIMITS.propSchemaFieldsMax + 1 }, (_, i) => [`p${i}`, { name: `p${i}`, type: 'string', optional: true }]));
  assert.throws(() => parsePropSchema(big), /exceeds \d+ fields/);
  const manyOptions = new Map([
    [
      'tag',
      {
        name: 'tag',
        type: 'T',
        optional: true,
        options: Array.from({ length: LIMITS.propOptionsMax + 1 }, (_, i) => `o${i}`),
      },
    ],
  ]);
  assert.throws(() => parsePropSchema(manyOptions), /options exceed \d+/);
});

// Use the real producer so a synthetic fixture cannot hide dropped renderer metadata.
test('Astro parser metadata survives the shared boundary', () => {
  const source = [
    '---',
    'type Props =',
    ' | { variant: "play"; /** Defaults to `Play`, or `Pause` when pressed. */',
    '     label?: string; pressed?: boolean; }',
    ' | { variant: "close"; /** Defaults to `Close`. */',
    '     label?: string; pressed?: never; };',
    'const { variant = "play", label, pressed } = Astro.props;',
    '---',
    '<button>{label}</button>',
  ].join('\n');
  const produced = parseAstroSchema(source);
  const scan = parseScanResult(
    structuredClone({
      pages: [],
      pageFolders: [],
      layouts: [],
      components: [{ name: 'Button', path: 'src/components/Button.astro', folder: '', schema: produced }],
    }),
  );
  const fields = scan.components[0]?.schema;
  assert.ok(fields);
  const expected = produced.map((field) => Object.fromEntries(Object.entries(field).filter(([key, value]) => key === 'default' || value !== undefined)));
  assert.deepEqual(fields, expected);
  const parsed = parsePropSchema(new Map(fields.map((field) => [field.name, field])));
  assert.ok(parsed.get('label')?.unions?.length);
});

test('control hints, expression defaults and exclusive bounds are preserved', () => {
  const field = {
    name: 'width',
    type: 'number',
    optional: true,
    default: 4,
    defaultExpr: true,
    defaultAsset: 'src/assets/width.webp',
    hint: 'inferred',
    min: 0,
    max: 10,
    step: 0.5,
    minExclusive: true,
    maxExclusive: true,
  };
  assert.deepEqual(parseField(field, 'width'), field);
  assert.deepEqual(parseField({ ...field, default: undefined }, 'width'), {
    ...field,
    default: undefined,
  });
});

test('nested schema metadata rejects invalid shapes and values', () => {
  const base = { name: 'item', type: 'code', optional: true };
  const branch = { forbids: [], pins: {}, defaults: {}, docs: {}, rules: {} };
  const invalid: readonly Readonly<Record<string, unknown>>[] = [
    { shape: {} },
    { shape: [jsonNull] },
    { shape: [{ name: 'x', type: 3 }] },
    { unions: [{}] },
    { unions: [{ names: [false], branches: [] }] },
    { unions: [{ names: ['x'], branches: [jsonNull] }] },
    { default: {} },
    { default: jsonNull },
    { default: Infinity },
    { hint: false },
    { doc: 0 },
    { defaultExpr: 1 },
    { defaultAsset: 1 },
    { defaultAsset: 'x'.repeat(LIMITS.attrCharsMax + 1) },
    { min: NaN },
    { max: Infinity },
    { step: -Infinity },
    { minExclusive: 'true' },
    { maxExclusive: 1 },
    { numeric: jsonNull },
  ];
  for (const metadata of invalid) {
    assert.throws(() => parseField({ ...base, ...metadata }, 'item'), /PropSchema/);
  }
  for (const metadata of [
    { forbids: [false] },
    { pins: { x: [3] } },
    { pins: jsonNull },
    { defaults: { x: true } },
    { defaults: jsonNull },
    { docs: { x: false } },
    { rules: { x: { prop: 'pressed', is: 'true', then: 'Pause' } } },
    { rules: jsonNull },
  ]) {
    const unions = [{ names: ['x'], branches: [{ ...branch, ...metadata }] }];
    assert.throws(() => parseField({ ...base, unions }, 'item'), /PropSchema/);
  }
});

test('nested schema collections and text have explicit bounds', () => {
  const base = { name: 'item', type: 'code', optional: true };
  const longText = 'x'.repeat(LIMITS.attrCharsMax + 1);
  const tooManyFields = Array.from({ length: LIMITS.propSchemaFieldsMax + 1 }, () => 'x');
  const tooManyOptions = Array.from({ length: LIMITS.propOptionsMax + 1 }, () => 'x');
  const branch = { forbids: [], pins: {}, defaults: {}, rules: {}, docs: {} };
  const metadataCases = [
    { name: longText },
    { type: longText },
    { doc: longText },
    { hint: longText },
    { default: longText },
    { options: [longText] },
    { shape: tooManyFields.map((name) => ({ name, type: 'string' })) },
    { unions: tooManyOptions.map(() => ({ names: [], branches: [] })) },
    { unions: [{ names: tooManyFields, branches: [] }] },
    { unions: [{ names: [], branches: tooManyOptions.map(() => branch) }] },
    { unions: [{ names: [], branches: [{ ...branch, forbids: tooManyFields }] }] },
    { unions: [{ names: [], branches: [{ ...branch, pins: { x: tooManyOptions } }] }] },
  ];
  for (const metadata of metadataCases) {
    assert.throws(() => parseField({ ...base, ...metadata }, 'item'), /exceed/);
  }
  assert.equal(parseField({ ...base, doc: 'x'.repeat(LIMITS.attrCharsMax) }, 'item').doc?.length, LIMITS.attrCharsMax);
});

// The code row and mixed choices travel with their own metadata: a function or
// `any` prop says so, with its type, and a choice says which options are written
// as expressions. Each is checked at the boundary like the rest.
test('code kinds, type text and expression options are preserved, and validated', () => {
  const action = { name: 'onSelect', type: 'other', optional: true, codeKind: 'function', typeText: '() => void' };
  const choice = { name: 'flag', type: 'enum', optional: true, options: ['true', 'false', 'auto'], expressionOptions: ['true', 'false'] };
  assert.deepEqual(parseField(structuredClone(action), 'onSelect'), action);
  assert.deepEqual(parseField(structuredClone(choice), 'flag'), choice);
  assert.throws(() => parseField({ ...action, codeKind: 'list' }, 'onSelect'), /codeKind: expected one of object, function, opaque/);
  assert.throws(() => parseField({ ...action, typeText: 7 }, 'onSelect'), /typeText: expected string/);
  assert.throws(() => parseField({ ...choice, expressionOptions: [true] }, 'flag'), /expressionOptions: expected string array/);
});

// A number prop's range comes from its doc: the @min/@max/@step tags, else a
// range its prose states outright ("0–1", "from 1 to 6", "between 2 and 8").
// The number field clamps to what this reads, so each form is pinned, and so
// is the negative space: a signed or reversed dash, a word like "h1-h6", and a
// date are not ranges, and a tag always wins over the prose beside it.
test('a number prop reads its declared range from tags and prose', () => {
  const source = [
    '---',
    'interface Props {',
    '  /** Opacity of the backdrop. @min 0 @max 1 @step 0.05 */',
    '  tagged?: number;',
    '  /** Overall strength, 0–1. */',
    '  dashed?: number;',
    '  /** Columns, from 1 to 6. */',
    '  spoken?: number;',
    '  /** Between 2 and 8 items. */',
    '  between?: number;',
    '  /** A level, 1-12. */',
    '  hyphen?: number;',
    '  /** Any heading, h1-h6. */',
    '  words?: number;',
    '  /** Shifted -1–1. */',
    '  signed?: number;',
    '  /** Reversed, 5–1. */',
    '  reversed?: number;',
    '  /** Released 2024-01. */',
    '  dated?: number;',
    '  /** Strength, 0–1. @max 0.8 */',
    '  overridden?: number;',
    '}',
    'const { tagged, dashed, spoken, between, hyphen, words, signed, reversed, dated, overridden } = Astro.props;',
    '---',
    '<div />',
  ].join('\n');
  const fields = new Map(parseAstroSchema(source).map((field) => [field.name, field]));
  const range = (name: string) => {
    const field = fields.get(name);
    assert.ok(field, `${name} is read`);
    return { min: field.min, max: field.max, step: field.step };
  };
  assert.deepEqual(range('tagged'), { min: 0, max: 1, step: 0.05 });
  assert.deepEqual(range('dashed'), { min: 0, max: 1, step: undefined });
  assert.deepEqual(range('spoken'), { min: 1, max: 6, step: undefined });
  assert.deepEqual(range('between'), { min: 2, max: 8, step: undefined });
  assert.deepEqual(range('hyphen'), { min: 1, max: 12, step: undefined });
  assert.deepEqual(range('words'), { min: undefined, max: undefined, step: undefined });
  assert.deepEqual(range('signed'), { min: undefined, max: undefined, step: undefined });
  assert.deepEqual(range('reversed'), { min: undefined, max: undefined, step: undefined });
  assert.deepEqual(range('dated'), { min: undefined, max: undefined, step: undefined });
  assert.deepEqual(range('overridden'), { min: 0, max: 0.8, step: undefined });
});

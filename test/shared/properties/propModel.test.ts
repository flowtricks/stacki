// Goal: shared/properties/propModel.ts parsePropModel accepts every model the
// producer can make and refuses every shape it must not, with a pinned message,
// so a model read from anywhere can be trusted by every panel.
//
// Methodology: one known-good prop per control kind passes intact (with
// nesting and a union table); then each known-bad shape fails, one change at a
// time from a good model: wrong kinds, missing fields, out-of-range numbers,
// duplicate names, and the bounds (nesting depth, variants, options, text).
// The tag reader every panel shares (propTags.ts) is pinned beside it, and the
// schema parser's new optional keys (`deprecated`, `usage`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROP_MODEL_LIMITS, parsePropModel } from '#dist/shared/properties/propModel.js';
import { PROP_TAG_LIMITS, readPropTags, tagStep, withoutSettingTags } from '#dist/shared/properties/propTags.js';
import { parseField } from '#dist/shared/properties/propSchema.js';

const NUMBER = { kind: 'number', min: 0, max: 10, minExclusive: false, maxExclusive: true, step: 0.5, decimals: 1 };

function prop(name: string, control: unknown, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name,
    typeText: 'string',
    control,
    presence: 'optional',
    declared: true,
    nullable: false,
    fallback: { kind: 'none' },
    documentation: '',
    tooltip: '',
    group: undefined,
    deprecated: undefined,
    format: undefined,
    recognition: { source: 'type' },
    usage: 'read',
    ...extra,
  };
}

// A group nested `depth` deep, built from the inside out (no recursion).
function group(depth: number): unknown {
  let control: unknown = { kind: 'text' };
  for (let level = 1; level <= depth; level++) {
    control = { kind: 'group', fields: [{ name: `level${level}`, typeText: '', control, presence: 'required' }] };
  }
  return control;
}

const goodModel = () => ({
  declaration: 'interface',
  props: [
    prop(
      'title',
      { kind: 'text' },
      { presence: 'required', documentation: 'The heading. @deprecated Use label.', tooltip: 'The heading.', deprecated: 'Use label.' },
    ),
    prop('count', NUMBER, { fallback: { kind: 'literal', value: 3, source: 'destructure' } }),
    prop('open', { kind: 'switch' }, { fallback: { kind: 'literal', value: true, source: 'doc' } }),
    prop(
      'size',
      {
        kind: 'choice',
        options: [
          { value: 'sm', written: 'string' },
          { value: '3', written: 'expression' },
        ],
        numeric: false,
      },
      { fallback: { kind: 'hint', hint: 'md, or lg when wide' } },
    ),
    prop('rest', { kind: 'attributes', tag: 'a' }, { declared: false, recognition: { source: 'usage', evidence: 'its default value' } }),
    prop('items', { kind: 'list', item: group(2) }, { fallback: { kind: 'expression', code: '[]' } }),
    prop('cta', group(PROP_MODEL_LIMITS.propNestingDepthMax)),
    prop('onPick', { kind: 'callback', signature: '(item: string) => void' }, { usage: 'unread' }),
    prop('data', { kind: 'code', reason: 'opaque' }, { recognition: { source: 'fallback' }, usage: 'unknown' }),
    prop('icon', { kind: 'code', reason: 'unrecognized' }, { recognition: { source: 'name', evidence: 'named icon' }, group: 'Media', format: 'icon' }),
    prop('tone', { kind: 'code', reason: 'untyped' }, { recognition: { source: 'tag', tag: '@format' }, nullable: true }),
  ],
  unions: [
    {
      names: ['kind', 'href'],
      branches: [
        { forbids: [], pins: { kind: ['link'] }, defaults: { label: 'Go' }, rules: {}, docs: { label: 'Defaults to Go.' } },
        {
          forbids: ['href'],
          pins: { kind: ['button'] },
          defaults: { size: 2 },
          rules: { label: { prop: 'open', is: 'true', then: 'Close', otherwise: 'Open' } },
          docs: {},
        },
      ],
    },
  ],
});

test('a model with every control kind passes intact', () => {
  const input = goodModel();
  const parsed = parsePropModel(structuredClone(input));
  assert.deepEqual(parsed, input);
  assert.deepEqual(
    parsed.props.map((entry) => entry.control.kind),
    ['text', 'number', 'switch', 'choice', 'attributes', 'list', 'group', 'callback', 'code', 'code', 'code'],
  );
});

// One change to a good model, by a function that edits a fresh copy.
function refuses(message: RegExp, change: (model: ReturnType<typeof goodModel>) => void): void {
  const model = goodModel();
  change(model);
  assert.throws(() => parsePropModel(model), message);
}
type Props = ReturnType<typeof goodModel>['props'];
const at = (props: Props, index: number): Record<string, unknown> => {
  const found = props[index];
  assert.ok(found, `prop ${index} exists`);
  return found;
};

test('every known-bad shape is refused with its path', () => {
  assert.throws(() => parsePropModel(undefined), /PropModel\.root: expected object/);
  assert.throws(() => parsePropModel({ declaration: 'interface', unions: [] }), /PropModel\.props: expected array/);
  refuses(/declaration: expected one of interface/, (model) => Object.assign(model, { declaration: 'class' }));
  refuses(/props: prop names must be unique/, (model) => model.props.push(prop('title', { kind: 'text' })));
  refuses(/props\[0\]\.name: expected non-empty string/, (model) => Object.assign(at(model.props, 0), { name: '' }));
  refuses(/props\[0\]\.control\.kind: expected one of/, (model) => Object.assign(at(model.props, 0), { control: { kind: 'colour' } }));
  refuses(/props\[0\]\.presence/, (model) => Object.assign(at(model.props, 0), { presence: 'maybe' }));
  refuses(/props\[0\]\.declared: expected boolean/, (model) => Object.assign(at(model.props, 0), { declared: 'yes' }));
  refuses(/props\[0\]\.usage: expected one of/, (model) => Object.assign(at(model.props, 0), { usage: 'used' }));
  refuses(/recognition\.evidence: expected string/, (model) => Object.assign(at(model.props, 0), { recognition: { source: 'usage' } }));
  refuses(/props\[1\]\.control: max is below min/, (model) => Object.assign(at(model.props, 1), { control: { ...NUMBER, min: 5, max: 1 } }));
  refuses(/control\.step: expected a positive step/, (model) => Object.assign(at(model.props, 1), { control: { ...NUMBER, step: 0 } }));
  refuses(/control\.decimals: expected a whole number/, (model) => Object.assign(at(model.props, 1), { control: { ...NUMBER, decimals: 1.5 } }));
  refuses(/control\.min: expected finite number/, (model) => Object.assign(at(model.props, 1), { control: { ...NUMBER, min: Number.NaN } }));
  refuses(/minExclusive: expected boolean/, (model) => Object.assign(at(model.props, 1), { control: { ...NUMBER, minExclusive: undefined } }));
  refuses(/options: a choice has at least two options/, (model) =>
    Object.assign(at(model.props, 3), { control: { kind: 'choice', options: [{ value: 'a', written: 'string' }], numeric: false } }),
  );
  refuses(/options must be unique/, (model) =>
    Object.assign(at(model.props, 3), {
      control: {
        kind: 'choice',
        options: [
          { value: 'a', written: 'string' },
          { value: 'a', written: 'expression' },
        ],
        numeric: false,
      },
    }),
  );
  refuses(/options\[0\]\.written/, (model) =>
    Object.assign(at(model.props, 3), {
      control: {
        kind: 'choice',
        options: [
          { value: 'a', written: 'code' },
          { value: 'b', written: 'string' },
        ],
        numeric: false,
      },
    }),
  );
  refuses(/fallback\.value/, (model) => Object.assign(at(model.props, 1), { fallback: { kind: 'literal', value: undefined, source: 'destructure' } }));
  refuses(/fallback\.source/, (model) => Object.assign(at(model.props, 1), { fallback: { kind: 'literal', value: 1, source: 'guess' } }));
  refuses(/fallback\.code: expected an expression/, (model) => Object.assign(at(model.props, 1), { fallback: { kind: 'expression', code: '  ' } }));
  refuses(/fallback\.hint: expected a hint/, (model) => Object.assign(at(model.props, 1), { fallback: { kind: 'hint', hint: '' } }));
  refuses(/fields: field names must be unique/, (model) =>
    Object.assign(at(model.props, 6), {
      control: {
        kind: 'group',
        fields: [
          { name: 'a', typeText: '', control: { kind: 'text' }, presence: 'required' },
          { name: 'a', typeText: '', control: { kind: 'text' }, presence: 'required' },
        ],
      },
    }),
  );
  refuses(/control\.reason: expected one of/, (model) => Object.assign(at(model.props, 8), { control: { kind: 'code', reason: 'because' } }));
  refuses(/unions\[0\]\.branches: a union has at least two branches/, (model) => (model.unions[0]?.branches.pop(), undefined));
  refuses(/defaults\.label: expected string/, (model) => Object.assign(model.unions[0]?.branches[0] ?? {}, { defaults: { label: true } }));
  refuses(/rules\.label\.is: expected string/, (model) => Object.assign(model.unions[0]?.branches[1] ?? {}, { rules: { label: { prop: 'open' } } }));
});

test('the bounds hold: nesting depth, variants, options, text and counts', () => {
  // A group one deeper than the bound is refused rather than walked.
  refuses(/nesting exceeds 4/, (model) => Object.assign(at(model.props, 6), { control: group(PROP_MODEL_LIMITS.propNestingDepthMax + 2) }));
  // A list of lists counts as nesting too.
  const deepList = (depth: number): unknown => {
    let control: unknown = { kind: 'text' };
    for (let level = 0; level < depth; level++) {
      control = { kind: 'list', item: control };
    }
    return control;
  };
  assert.doesNotThrow(() => parsePropModel({ ...goodModel(), props: [prop('a', deepList(PROP_MODEL_LIMITS.propNestingDepthMax))] }));
  assert.throws(() => parsePropModel({ ...goodModel(), props: [prop('a', deepList(PROP_MODEL_LIMITS.propNestingDepthMax + 1))] }), /nesting exceeds 4/);
  const branch = { forbids: [], pins: {}, defaults: {}, rules: {}, docs: {} };
  const variants = (count: number) => ({ ...goodModel(), unions: [{ names: [], branches: Array.from({ length: count }, () => branch) }] });
  assert.doesNotThrow(() => parsePropModel(variants(PROP_MODEL_LIMITS.propVariantsMax)));
  assert.throws(() => parsePropModel(variants(PROP_MODEL_LIMITS.propVariantsMax + 1)), /branches: exceeds 32 entries/);
  const options = (count: number) => ({
    ...goodModel(),
    props: [
      prop('a', { kind: 'choice', options: Array.from({ length: count }, (_, index) => ({ value: String(index), written: 'expression' })), numeric: true }),
    ],
  });
  assert.doesNotThrow(() => parsePropModel(options(PROP_MODEL_LIMITS.optionsMax)));
  assert.throws(() => parsePropModel(options(PROP_MODEL_LIMITS.optionsMax + 1)), /options: exceeds 256 entries/);
  const many = (count: number) => ({ ...goodModel(), props: Array.from({ length: count }, (_, index) => prop(`p${index}`, { kind: 'text' })) });
  assert.doesNotThrow(() => parsePropModel(many(PROP_MODEL_LIMITS.propsMax)));
  assert.throws(() => parsePropModel(many(PROP_MODEL_LIMITS.propsMax + 1)), /props: exceeds 512 entries/);
  refuses(/typeText: exceeds 8192 characters/, (model) => Object.assign(at(model.props, 0), { typeText: 'x'.repeat(PROP_MODEL_LIMITS.typeTextCharsMax + 1) }));
  refuses(/documentation: exceeds/, (model) => Object.assign(at(model.props, 0), { documentation: 'x'.repeat(PROP_MODEL_LIMITS.docCharsMax + 1) }));
  // Valid data as it becomes invalid: the longest text passes, one more character fails.
  assert.doesNotThrow(() =>
    parsePropModel({ ...goodModel(), props: [prop('a', { kind: 'text' }, { typeText: 'x'.repeat(PROP_MODEL_LIMITS.typeTextCharsMax) })] }),
  );
});

test('the tag reader: every tag the panels write, read the same everywhere', () => {
  const tags = readPropTags('How many columns. @min 1 @max 6 @decimals 0 @group Layout');
  assert.deepEqual([tags.tooltip, tags.min, tags.max, tags.decimals, tags.group, tagStep(tags)], ['How many columns.', 1, 6, 0, 'Layout', 1]);
  // Legacy switch labels are not settings any more: ignored, and kept out of the tooltip.
  const labels = readPropTags('Show it. @onLabel Shown @offLabel Hidden');
  assert.equal(labels.tooltip, 'Show it.');
  assert.equal('onLabel' in labels, false);
  assert.equal(withoutSettingTags('Show it. @onLabel Shown @offLabel Hidden'), 'Show it.');
  assert.equal(readPropTags('@format Color').format, 'color');
  assert.equal(readPropTags('Old. @deprecated Use `label` instead.').deprecated, 'Use `label` instead.');
  assert.equal(readPropTags('@deprecated').deprecated, '');
  assert.deepEqual([tagStep(readPropTags('@decimals 2')), tagStep(readPropTags('@int')), tagStep(readPropTags('@step 5 @decimals 2'))], [0.01, 1, 5]);
  // Negative space: nothing stated, or stated wrong, is absent.
  const none = readPropTags(undefined);
  assert.deepEqual([none.tooltip, none.min, none.deprecated, none.integer, tagStep(none)], ['', undefined, undefined, false, undefined]);
  assert.equal(readPropTags('@max 2 @min 5').max, undefined, 'a max below the min is dropped');
  assert.equal(readPropTags('@decimals 99').decimals, undefined);
  assert.equal(readPropTags('@step 0').step, undefined);
  assert.equal(readPropTags('@min ten').min, undefined);
  assert.equal(readPropTags('@MIN 3').min, 3, 'number tags ignore case');
  assert.equal(readPropTags('the minimum, not a tag: @minimal 3').min, undefined);
  assert.equal(withoutSettingTags('Count. @min 0 @max 9 @group Layout @deprecated Gone.'), 'Count. @deprecated Gone.');
  assert.throws(() => readPropTags('x'.repeat(PROP_TAG_LIMITS.docCharsMax + 1)), /readPropTags: doc text is bounded/);
});

test('schema fields carry the model’s deprecation and usage, and refuse bad ones', () => {
  const field = parseField({ name: 'text', type: 'string', optional: true, deprecated: 'Use label.', usage: 'unread' }, 'text');
  assert.deepEqual([field.deprecated, field.usage], ['Use label.', 'unread']);
  assert.equal(parseField({ name: 'text', type: 'string', optional: true, deprecated: '' }, 'text').deprecated, '');
  assert.equal('usage' in parseField({ name: 'text', type: 'string', optional: true }, 'text'), false, 'absent stays absent');
  assert.throws(
    () => parseField({ name: 'text', type: 'string', optional: true, usage: 'used' }, 'text'),
    /text\.usage: expected one of read, unread, unknown/,
  );
  assert.throws(() => parseField({ name: 'text', type: 'string', optional: true, deprecated: 3 }, 'text'), /text\.deprecated: expected string/);
});

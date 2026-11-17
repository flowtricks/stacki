// Goal: a prop's Visibility set by conditions maps both ways onto the
// discriminated unions TypeScript checks. One controller that only shows or
// hides the prop reads Show first, Hide the Else, naming the shorter list;
// other rules read as Hide groups, then Required groups, Show the Else; an edited model
// writes back as one rule per controller exactly when the conditions mean
// what the strictest of the unions' rules means for every combination of
// options, and is refused with its reason otherwise (never written another
// way): two conditions in one group, a prop that is not a choice or a switch,
// a value that is not a state, a combination TypeScript cannot say. Its `{}`
// view (visibilityCode) prints those unions' members for the prop.
// Method: the pure model (src/features/props/visibility.ts), bundled with
// esbuild, driven table-first over Button's real rules (label by variant;
// disabled by element and variant) and small shapes: read, write back, and
// compare with the rules read; then each refused shape; then the code view
// over a plain prop, a fallback option, a switch and a member with no type.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/visibility');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'visibility.cjs');
buildSync({
  stdin: { contents: "export * from './src/features/props/visibility';", resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const model = require(output);

const VARIANT = { name: 'variant', options: ['main', 'link', 'play', 'close', 'arrow'], kind: 'string' };
const ELEMENT = { name: 'element', options: ['button', 'link'], kind: 'string' };
const PRESSED = { name: 'pressed', options: ['true', 'false'], kind: 'boolean' };
const CONTROLLERS = [ELEMENT, VARIANT, PRESSED];
const rule = (controller, states) => ({
  controller: controller.name,
  states: controller.options.map((option) => ({ option, state: states[option] ?? 'optional' })),
});
const is = (subject, ...values) => ({ kind: 'compare', subject, operator: 'in', values: values.map((value) => ({ kind: 'string', value })) });
const state = (text) => ({ kind: 'text', text });

const ROUND_TRIPS = [
  { name: 'label: Hide for main and link', rules: [rule(VARIANT, { main: 'forbidden', link: 'forbidden' })] },
  { name: 'Required for play, Hide for main', rules: [rule(VARIANT, { main: 'forbidden', play: 'required' })] },
  { name: 'disabled: Hide for element link and for variant link', rules: [rule(ELEMENT, { link: 'forbidden' }), rule(VARIANT, { link: 'forbidden' })] },
  { name: 'a switch: Hide when pressed is false', rules: [rule(PRESSED, { false: 'forbidden' })] },
];

for (const row of ROUND_TRIPS) {
  test(`round trip: ${row.name}`, () => {
    const read = model.visibilityConditional(row.rules, CONTROLLERS);
    const written = model.visibilityRules(read, CONTROLLERS);
    assert.ok(written.ok, JSON.stringify(written));
    assert.deepEqual(written.value, row.rules);
  });
}

test('label reads Show first: none of the two hiding options shows it, Hide the Else', () => {
  const read = model.visibilityConditional([rule(VARIANT, { main: 'forbidden', link: 'forbidden' })], CONTROLLERS);
  const notAny = {
    kind: 'compare',
    subject: 'variant',
    operator: 'notIn',
    values: [
      { kind: 'string', value: 'main' },
      { kind: 'string', value: 'link' },
    ],
  };
  assert.deepEqual(read, { groups: [{ match: 'all', conditions: [notAny], value: state('optional') }], otherwise: state('forbidden') });
});

test('Show first names the shorter list: the shown options when they are fewer', () => {
  const read = model.visibilityConditional([rule(VARIANT, { main: 'forbidden', link: 'forbidden', play: 'forbidden', close: 'forbidden' })], CONTROLLERS);
  assert.deepEqual(read, { groups: [{ match: 'all', conditions: [is('variant', 'arrow')], value: state('optional') }], otherwise: state('forbidden') });
});

test('Show first on a switch: shown when pressed, Hide the Else', () => {
  const read = model.visibilityConditional([rule(PRESSED, { false: 'forbidden' })], CONTROLLERS);
  assert.deepEqual(read, {
    groups: [{ match: 'all', conditions: [{ kind: 'test', subject: 'pressed', operator: 'truthy' }], value: state('optional') }],
    otherwise: state('forbidden'),
  });
});

const AS_WRITTEN = [
  { name: 'Required in the rule', rules: [rule(VARIANT, { main: 'forbidden', play: 'required' })] },
  { name: 'two controllers', rules: [rule(ELEMENT, { link: 'forbidden' }), rule(VARIANT, { link: 'forbidden' })] },
  {
    name: 'an open set: the rule names options the controller does not list',
    rules: [{ controller: 'variant', states: [...rule(VARIANT, { main: 'forbidden' }).states, { option: 'huge', state: 'optional' }] }],
  },
];

for (const row of AS_WRITTEN) {
  test(`as written, Hide first: ${row.name}`, () => {
    const read = model.visibilityConditional(row.rules, CONTROLLERS);
    assert.equal(read.otherwise.text, 'optional', 'Show is the Else');
    assert.equal(read.groups[0].value.text, 'forbidden', 'Hide comes first');
  });
}

test('refused: a test kept as code names no prop', () => {
  const written = model.visibilityRules(
    { groups: [{ match: 'all', conditions: [{ kind: 'code', code: 'index >= 3' }], value: state('forbidden') }], otherwise: state('optional') },
    CONTROLLERS,
  );
  assert.equal(written.ok, false);
  assert.equal(written.error.kind, 'shape');
});

test('from scratch: a group per state on any controller writes that controller’s rule; an all-Show controller rules nothing', () => {
  const written = model.visibilityRules(
    {
      groups: [
        { match: 'all', conditions: [is('variant', 'main')], value: state('forbidden') },
        { match: 'all', conditions: [is('variant', 'play')], value: state('required') },
        { match: 'all', conditions: [is('element', 'button')], value: state('optional') },
      ],
      otherwise: state('optional'),
    },
    CONTROLLERS,
  );
  assert.ok(written.ok);
  assert.deepEqual(written.value, [rule(VARIANT, { main: 'forbidden', play: 'required' })]);
});

test('no conditions: no rules, the Else is the plain state', () => {
  assert.deepEqual(model.visibilityRules({ groups: [], otherwise: state('required') }, CONTROLLERS), { ok: true, value: [] });
});

const REFUSED = [
  {
    name: 'two conditions in one group',
    kind: 'shape',
    groups: [{ match: 'all', conditions: [is('variant', 'play'), { kind: 'test', subject: 'pressed', operator: 'truthy' }], value: state('required') }],
  },
  { name: 'a value that is not a state', kind: 'shape', groups: [{ match: 'all', conditions: [is('variant', 'play')], value: state('Pause') }] },
  { name: 'a prop that is not a choice or a switch', kind: 'subject', groups: [{ match: 'all', conditions: [is('label', 'x')], value: state('required') }] },
  { name: 'an option the controller does not have', kind: 'shape', groups: [{ match: 'all', conditions: [is('variant', 'huge')], value: state('required') }] },
  {
    name: 'Show first, then Hide: a combination the strictest rule cannot say',
    kind: 'combination',
    groups: [
      { match: 'all', conditions: [is('element', 'button')], value: state('optional') },
      { match: 'all', conditions: [is('variant', 'link')], value: state('forbidden') },
    ],
  },
];

for (const row of REFUSED) {
  test(`refused: ${row.name}`, () => {
    const written = model.visibilityRules({ groups: row.groups, otherwise: state('optional') }, CONTROLLERS);
    assert.equal(written.ok, false);
    assert.equal(written.error.kind, row.kind);
  });
}

test('an Else that is not Show is each named controller’s rule for its other options', () => {
  const forbid = (subject, value) => ({ match: 'all', conditions: [is(subject, value)], value: state('forbidden') });
  const written = model.visibilityRules({ groups: [forbid('variant', 'main'), forbid('element', 'link')], otherwise: state('required') }, CONTROLLERS);
  assert.ok(written.ok);
  assert.deepEqual(written.value, [
    rule(VARIANT, { main: 'forbidden', link: 'required', play: 'required', close: 'required', arrow: 'required' }),
    rule(ELEMENT, { button: 'required', link: 'forbidden' }),
  ]);
});

// A group as main reads it: options in order, one rule per prop, the fallback marked.
const group = (controller, optionKind, options, rules) => ({
  controller,
  props: ['label'],
  attachable: [],
  optionKind,
  editing: { kind: 'editable' },
  options: options.map((value, index) => ({ value, fallback: index === 0, rules: [{ prop: 'label', listed: true, description: '', ...rules[value] }] })),
});
const LABEL = { name: 'label', type: 'string', required: false };

test('code: a prop no union rules is its own declaration, optional or needed', () => {
  assert.equal(model.visibilityCode(LABEL, []), 'label?: string;');
  assert.equal(model.visibilityCode({ ...LABEL, required: true }, []), 'label: string;');
  assert.equal(model.visibilityCode({ ...LABEL, type: '' }, []), 'label?: unknown;');
});

test('code: each ruling union lists its members, the fallback optional, hidden as never, required without ?', () => {
  const variant = group('variant', 'string', ['main', 'play'], {
    main: { state: 'forbidden', type: '' },
    play: { state: 'required', type: '"Play" | "Pause"' },
  });
  assert.equal(
    model.visibilityCode(LABEL, [variant]),
    ['// By variant', '  | { variant?: "main"; label?: never }', '  | { variant: "play"; label: "Play" | "Pause" }'].join('\n'),
  );
});

test('code: a switch is written as true / false, and a candidate group rules nothing', () => {
  const pressed = group('pressed', 'boolean', ['false', 'true'], { false: { state: 'optional', type: '' }, true: { state: 'forbidden', type: '' } });
  const candidate = { ...group('variant', 'string', ['main'], { main: { state: 'forbidden', type: '' } }), editing: { kind: 'candidate' } };
  assert.equal(
    model.visibilityCode(LABEL, [pressed, candidate]),
    ['// By pressed', '  | { pressed?: false; label?: string }', '  | { pressed: true; label?: never }'].join('\n'),
  );
});

test('code: a prop with no name is a programmer error', () => {
  assert.throws(() => model.visibilityCode({ ...LABEL, name: '' }, []), /Assertion failed: visibilityCode: the prop has a name/);
});

test('tooltip code: the prop’s own comment above it, one line or a block, none for no words', () => {
  assert.equal(model.tooltipCode({ ...LABEL, description: 'Accessible label.' }, undefined), '/** Accessible label. */\nlabel?: string;');
  assert.equal(model.tooltipCode({ ...LABEL, description: 'One.\nTwo.' }, undefined), '/**\n * One.\n * Two.\n */\nlabel?: string;');
  assert.equal(model.tooltipCode({ ...LABEL, description: '  ' }, undefined), 'label?: string;');
});

test('tooltip code: each member carries its own comment; a hidden member has none', () => {
  const variant = group('variant', 'string', ['main', 'play'], {
    main: { state: 'forbidden', type: '', description: 'Never shown.' },
    play: { state: 'optional', type: '', description: 'Plays.' },
  });
  assert.equal(
    model.tooltipCode({ ...LABEL, description: '' }, variant),
    ['// By variant', '  | { variant?: "main"; label?: never }', '  | { variant: "play"; /** Plays. */ label?: string }'].join('\n'),
  );
});

test('tooltip code: a group that does not name the prop is a programmer error', () => {
  const other = { ...group('variant', 'string', ['main'], { main: { state: 'optional', type: '' } }), props: ['href'] };
  assert.throws(() => model.tooltipCode({ ...LABEL, description: '' }, other), /Assertion failed: tooltipCode: the group names the prop/);
});

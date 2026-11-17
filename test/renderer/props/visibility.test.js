// Goal: a prop's Visibility set by conditions maps both ways onto the
// discriminated unions TypeScript checks. Each union's rules read as Not
// allowed groups, then Required groups, Allowed the Else; an edited model
// writes back as one rule per controller exactly when the conditions mean
// what the strictest of the unions' rules means for every combination of
// options, and is refused with its reason otherwise (never written another
// way): two conditions in one group, a prop that is not a choice or a switch,
// a value that is not a state, a combination TypeScript cannot say.
// Method: the pure model (src/features/props/visibility.ts), bundled with
// esbuild, driven table-first over Button's real rules (label by variant;
// disabled by element and variant) and small shapes: read, write back, and
// compare with the rules read; then each refused shape.

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
  { name: 'label: Not allowed for main and link', rules: [rule(VARIANT, { main: 'forbidden', link: 'forbidden' })] },
  { name: 'Required for play, Not allowed for main', rules: [rule(VARIANT, { main: 'forbidden', play: 'required' })] },
  { name: 'disabled: Not allowed for element link and for variant link', rules: [rule(ELEMENT, { link: 'forbidden' }), rule(VARIANT, { link: 'forbidden' })] },
  { name: 'a switch: Not allowed when pressed is false', rules: [rule(PRESSED, { false: 'forbidden' })] },
];

for (const row of ROUND_TRIPS) {
  test(`round trip: ${row.name}`, () => {
    const read = model.visibilityConditional(row.rules, CONTROLLERS);
    const written = model.visibilityRules(read, CONTROLLERS);
    assert.ok(written.ok, JSON.stringify(written));
    assert.deepEqual(written.value, row.rules);
  });
}

test('label reads as one Not allowed group and Allowed otherwise', () => {
  const read = model.visibilityConditional([rule(VARIANT, { main: 'forbidden', link: 'forbidden' })], CONTROLLERS);
  assert.deepEqual(read, { groups: [{ match: 'all', conditions: [is('variant', 'main', 'link')], value: state('forbidden') }], otherwise: state('optional') });
});

test('from scratch: a group per state on any controller writes that controller’s rule; an all-Allowed controller rules nothing', () => {
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
    name: 'Allowed first, then Not allowed: a combination the strictest rule cannot say',
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

test('an Else that is not Allowed is each named controller’s rule for its other options', () => {
  const forbid = (subject, value) => ({ match: 'all', conditions: [is(subject, value)], value: state('forbidden') });
  const written = model.visibilityRules({ groups: [forbid('variant', 'main'), forbid('element', 'link')], otherwise: state('required') }, CONTROLLERS);
  assert.ok(written.ok);
  assert.deepEqual(written.value, [
    rule(VARIANT, { main: 'forbidden', link: 'required', play: 'required', close: 'required', arrow: 'required' }),
    rule(ELEMENT, { button: 'required', link: 'forbidden' }),
  ]);
});

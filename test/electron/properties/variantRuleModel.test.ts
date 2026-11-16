// Goal: the variant rule reader models a component's discriminated props
// unions exactly as TypeScript reads them, so the panel can draw and edit which
// props each option allows, requires or forbids, and it marks read-only, with
// one reason, every shape the writer could not edit faithfully.
// Method: read the Lumos starter's Button.astro (a real fixture: `Props` is an
// object type intersected with two unions, one keyed by `element`, one by
// `variant`, with `never` members, attribute pass-throughs and a shared alias)
// and pin the whole model. Then the negative space: each unmodelable shape on
// its own (exported, nested, local alias members, methods, numeric or repeated
// controllers, several runtime types) and the shapes that are no group at all.
// The boundary parser is held to the same model: what the reader produces
// parses, and each broken shape is refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readVariantGroups } from '#dist/electron/properties/variantRuleModel.js';
import { parseVariantGroups, parseVariantRuleEdit, variantGroupOf, variantOptionValue } from '#dist/shared/properties/variantRules.js';
import type { VariantGroup } from '#dist/shared/properties/variantRules.js';

// The gate runs every suite from the repository root.
const BUTTON = fs.readFileSync('test/fixtures/variantRules/Button.astro', 'utf8');

function component(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n<div />\n`;
}

function groupOf(groups: readonly VariantGroup[], controller: string): VariantGroup {
  const group = groups.find((candidate) => candidate.controller === controller);
  assert.ok(group, `no group for ${controller}: ${groups.map((candidate) => candidate.controller).join(', ')}`);
  return group;
}

function states(group: VariantGroup): Record<string, Record<string, string>> {
  return Object.fromEntries(
    group.options.map((option) => [
      option.value,
      Object.fromEntries(option.rules.map((rule) => [rule.prop, rule.state === 'forbidden' ? rule.state : `${rule.state} ${rule.type}`])),
    ]),
  );
}

test('the Button fixture reads as two editable groups, element then variant', () => {
  const groups = readVariantGroups(BUTTON);
  assert.deepEqual(
    groups.map((group) => [group.controller, group.editing.kind]),
    [
      ['element', 'editable'],
      ['variant', 'editable'],
    ],
  );
});

test('the element group: button is the fallback, link forbids the button-only props', () => {
  const group = groupOf(readVariantGroups(BUTTON), 'element');
  assert.deepEqual(group.props, ['type', 'disabled', 'href']);
  assert.deepEqual(
    group.options.map((option) => [option.value, option.fallback]),
    [
      ['button', true],
      ['link', false],
    ],
  );
  assert.deepEqual(states(group), {
    button: { type: 'optional "button" | "submit" | "reset"', disabled: 'optional boolean', href: 'forbidden' },
    link: { type: 'forbidden', disabled: 'forbidden', href: 'optional string' },
  });
});

test('the variant group: every prop listed in every option, shared alias kept as written', () => {
  const group = groupOf(readVariantGroups(BUTTON), 'variant');
  assert.deepEqual(group.props, ['emphasis', 'label', 'pressed', 'direction']);
  assert.deepEqual(
    group.options.map((option) => option.value),
    ['main', 'link', 'play', 'close', 'arrow'],
  );
  assert.deepEqual(
    group.options.filter((option) => option.fallback).map((option) => option.value),
    ['main'],
  );
  assert.ok(group.options.every((option) => option.rules.every((rule) => rule.listed)));
  assert.deepEqual(states(group), {
    main: { emphasis: 'optional Emphasis', label: 'forbidden', pressed: 'forbidden', direction: 'forbidden' },
    link: { emphasis: 'forbidden', label: 'forbidden', pressed: 'forbidden', direction: 'forbidden' },
    play: { emphasis: 'optional Emphasis', label: 'optional string', pressed: 'optional boolean', direction: 'forbidden' },
    close: { emphasis: 'optional Emphasis', label: 'optional string', pressed: 'forbidden', direction: 'forbidden' },
    arrow: { emphasis: 'optional Emphasis', label: 'optional string', pressed: 'forbidden', direction: 'optional "forward" | "back"' },
  });
});

test('a required prop, an unlisted prop and a union written as Props itself', () => {
  const groups = readVariantGroups(
    component(
      [
        'type Props =',
        '  | { kind: "card"; title: string; image?: string }',
        '  | { kind: "quote"; author?: string };',
        'const { kind, title, image, author } = Astro.props;',
      ].join('\n'),
    ),
  );
  const group = groupOf(groups, 'kind');
  assert.equal(group.editing.kind, 'editable');
  assert.deepEqual(group.props, ['title', 'image', 'author']);
  assert.deepEqual(
    group.options.map((option) => option.rules.map((rule) => [rule.prop, rule.state, rule.listed])),
    [
      [
        ['title', 'required', true],
        ['image', 'optional', true],
        ['author', 'forbidden', false],
      ],
      [
        ['title', 'forbidden', false],
        ['image', 'forbidden', false],
        ['author', 'optional', true],
      ],
    ],
  );
  assert.deepEqual(
    group.options.map((option) => option.fallback),
    [false, false],
  );
});

test('the props every option shares can be attached to each editable group', () => {
  const groups = readVariantGroups(BUTTON);
  assert.deepEqual(
    groups.map((group) => [group.controller, group.attachable]),
    [
      ['element', ['render']],
      ['variant', ['render']],
    ],
  );
  const exported = readVariantGroups(component(['export type Props = { size?: string } & (', '  | { variant?: "a" }', '  | { variant: "b" });'].join('\n')));
  assert.deepEqual(exported[0]?.attachable, []);
});

test('the group of a prop is the one it controls, else the one that rules it', () => {
  const groups = readVariantGroups(BUTTON);
  assert.equal(variantGroupOf(groups, 'variant')?.controller, 'variant');
  assert.equal(variantGroupOf(groups, 'label')?.controller, 'variant');
  assert.equal(variantGroupOf(groups, 'href')?.controller, 'element');
  assert.equal(variantGroupOf(groups, 'render'), undefined);
  assert.equal(variantGroupOf(undefined, 'variant'), undefined);
});

// Negative space: each shape the writer could not edit faithfully, alone.
const KIND = ['  | { variant?: "a"; label?: never }', '  | { variant: "b"; label?: string };'];

const READ_ONLY: readonly (readonly [string, string, readonly string[]])[] = [
  ['an exported union is read by other files', 'shared', ['type Props = Kind;', 'export type Kind =', ...KIND]],
  ['an exported Props is read by other files', 'shared', ['export type Props =', ...KIND]],
  ['a member holding another union', 'nested', ['type Props =', '  | ({ variant?: "a" } & ({ x?: string } | { y?: string }))', '  | { variant: "b" };']],
  ['a member built on a local alias', 'shape', ['type Base = { size?: string };', 'type Props =', '  | (Base & { variant?: "a" })', '  | { variant: "b" };']],
  ['a member with a method', 'shape', ['type Props =', '  | { variant?: "a"; go(): void }', '  | { variant: "b" };']],
  ['a member with a quoted key', 'shape', ['type Props =', '  | { variant?: "a"; "data-x"?: string }', '  | { variant: "b" };']],
  ['a member split over two object types', 'shape', ['type Props =', '  | ({ variant?: "a" } & { label?: string })', '  | { variant: "b" };']],
  ['a member with a mapped type', 'shape', ['type Props =', '  | ({ variant?: "a" } & { [K in "x"]?: string })', '  | { variant: "b" };']],
  [
    'two runtime types',
    'runtime',
    ['type Props =', ...KIND, 'type A = { variant?: string };', 'const one = Astro.props as A;', 'const two = Astro.props as A;'],
  ],
  ['a runtime union', 'runtime', ['type Props =', ...KIND, 'type A = { label?: string } | { other?: string };', 'const all = Astro.props as A;']],
  ['two destructures', 'runtime', ['type Props =', ...KIND, 'const { variant } = Astro.props;', 'const { label } = Astro.props;']],
];

for (const [title, reason, lines] of READ_ONLY) {
  test(`read-only with a reason: ${title}`, () => {
    const groups = readVariantGroups(component(lines.join('\n')));
    const group = groupOf(groups, 'variant');
    assert.deepEqual(group.editing, { kind: 'readonly', reason });
    assert.deepEqual(parseVariantGroups(JSON.parse(JSON.stringify(groups))), groups);
  });
}

const NO_GROUP: readonly (readonly [string, readonly string[]])[] = [
  ['a plain object type', ['type Props = { variant?: "a"; label?: string };']],
  ['an interface', ['interface Props { variant?: "a" | "b"; label?: string }']],
  ['a numeric controller', ['type Props = { size: 1; a?: string } | { size: 2; b?: string };']],
  ['a repeated option', ['type Props = { variant?: "a"; x?: string } | { variant: "a"; y?: string };']],
  ['a union of literals', ['type Props = "a" | "b";']],
  ['a controller missing from one member', ['type Props = { variant?: "a" } | { label?: string };']],
  ['a generic Props', ['type Props<T> = { variant?: "a"; v?: T } | { variant: "b" };']],
  ['Props declared twice', ['type Props = { variant?: "a" } | { variant: "b" };', 'interface Props { x?: string }']],
  ['no Props at all', ['const { variant } = Astro.props;']],
];

for (const [title, lines] of NO_GROUP) {
  test(`no group: ${title}`, () => {
    assert.deepEqual(readVariantGroups(component(lines.join('\n'))), []);
  });
}

test('the boundary parser accepts the Button model and refuses each broken shape', () => {
  const groups = readVariantGroups(BUTTON);
  const wire: unknown = JSON.parse(JSON.stringify(groups));
  assert.deepEqual(parseVariantGroups(wire), groups);
  const variant = groupOf(groups, 'variant');
  const broken: readonly (readonly [string, unknown])[] = [
    ['props repeat', [{ ...variant, props: ['label', 'label', 'pressed', 'direction'] }]],
    ['controller rules itself', [{ ...variant, props: ['variant', 'label', 'pressed', 'direction'] }]],
    ['options repeat', [{ ...variant, options: [variant.options[0], variant.options[0]] }]],
    ['a rule is missing', [{ ...variant, options: [{ ...variant.options[0], rules: [] }] }]],
    ['an unknown state', [{ ...variant, options: [{ ...variant.options[0], rules: variant.options[0]?.rules.map((rule) => ({ ...rule, state: 'maybe' })) }] }]],
    [
      'a forbidden prop with a type',
      [{ ...variant, options: [{ ...variant.options[1], rules: variant.options[1]?.rules.map((rule) => ({ ...rule, type: 'string' })) }] }],
    ],
    [
      'an unlisted prop that is allowed',
      [{ ...variant, options: [{ ...variant.options[2], rules: variant.options[2]?.rules.map((rule) => ({ ...rule, listed: false })) }] }],
    ],
    ['an attachable prop the group rules', [{ ...variant, attachable: ['label'] }]],
    ['an unknown reason', [{ ...variant, editing: { kind: 'readonly', reason: 'other' } }]],
    ['a quoted option', [{ ...variant, options: [{ ...variant.options[0], value: 'ma"in' }] }]],
    ['too many groups', Array.from({ length: 17 }, () => variant)],
  ];
  for (const [title, input] of broken) {
    assert.throws(() => parseVariantGroups(JSON.parse(JSON.stringify(input))), Error, title);
  }
});

test('option values: trimmed words, never quotes, backslashes or control characters', () => {
  assert.equal(variantOptionValue('  primary button '), 'primary button');
  assert.equal(variantOptionValue(''), undefined);
  assert.equal(variantOptionValue('   '), undefined);
  assert.equal(variantOptionValue('a"b'), undefined);
  assert.equal(variantOptionValue("a'b"), undefined);
  assert.equal(variantOptionValue('a`b'), undefined);
  assert.equal(variantOptionValue('a\\b'), undefined);
  assert.equal(variantOptionValue('a\nb'), undefined);
  assert.equal(variantOptionValue('x'.repeat(129)), undefined);
  assert.equal(variantOptionValue('x'.repeat(128)), 'x'.repeat(128));
});

test('the edit parser accepts each edit and refuses its broken forms', () => {
  const good: readonly unknown[] = [
    { kind: 'setRule', controller: 'variant', option: 'main', prop: 'label', state: 'required' },
    { kind: 'addOption', controller: 'variant', value: 'ghost' },
    { kind: 'renameOption', controller: 'variant', from: 'main', to: 'primary' },
    { kind: 'removeOption', controller: 'variant', value: 'link' },
    { kind: 'moveOption', controller: 'variant', value: 'link', index: 0 },
    { kind: 'setFallback', controller: 'variant', value: 'play' },
    { kind: 'addProp', controller: 'variant', prop: 'icon', type: 'string' },
    { kind: 'removeProp', controller: 'variant', prop: 'label' },
    { kind: 'attachProp', controller: 'variant', prop: 'render', options: ['link', 'play'] },
  ];
  for (const edit of good) {
    assert.deepEqual(parseVariantRuleEdit(edit), edit);
  }
  const bad: readonly unknown[] = [
    { kind: 'setRule', controller: 'variant', option: 'main', prop: 'label', state: 'sometimes' },
    { kind: 'setRule', controller: 'variant', option: 'main', prop: 'not a name', state: 'required' },
    { kind: 'addOption', controller: 'variant', value: ' ghost' },
    { kind: 'addOption', controller: 'variant', value: 'gh"ost' },
    { kind: 'renameOption', controller: 'variant', from: 'main', to: 'main' },
    { kind: 'moveOption', controller: 'variant', value: 'link', index: -1 },
    { kind: 'moveOption', controller: 'variant', value: 'link', index: 64 },
    { kind: 'addProp', controller: 'variant', prop: 'icon', type: '  ' },
    { kind: 'attachProp', controller: 'variant', prop: 'render', options: [] },
    { kind: 'attachProp', controller: 'variant', prop: 'render', options: ['link', 'link'] },
    { kind: 'unknown' },
    'setRule',
  ];
  for (const edit of bad) {
    assert.throws(() => parseVariantRuleEdit(edit), Error, JSON.stringify(edit));
  }
});

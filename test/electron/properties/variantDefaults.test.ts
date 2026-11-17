// Goal: a default a component computes per option from a lookup table
// (`label ?? named[variant]`) is read as entries keyed by that prop's options,
// and written back into the table as the smallest change: an unchanged entry
// keeps its bytes, a changed one has only its value replaced, a dropped one
// goes with its separator, a new one follows the table's own layout. Any other
// `prop ?? code` is read as computed code and never written. A conditional
// destructure default that reads a later prop moves its own entry after it, so
// the destructure never reads a local before it exists. Each option of a
// discriminated union reads its own tooltip for the prop.
// Method: table-driven round trips over the Lumos Button fixture and small
// components shaped like the corpus (docs/props-complex-shapes.md): read,
// edit, compare the whole output with the input plus the exact replacements,
// read again and compare with what was asked; then the negative space: shapes
// the reader must not take as tables, refusals that leave the bytes alone, and
// edits that change nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { editVariantDefaultTable, readVariantDefaults } from '#dist/electron/properties/variantDefaults.js';
import { orderDefaultReads } from '#dist/electron/properties/defaultOrder.js';
import { readPropertySyntax } from '#dist/electron/properties/propertySyntax.js';
import { readComponentProperties, editPropertyDefinition } from '#dist/electron/properties/propertyDefinitions.js';
import { parseComponentProperties } from '#dist/shared/properties/propertyEditing.js';
import { parseVariantRuleEdit } from '#dist/shared/properties/variantRules.js';
import type { VariantDefaultEntry } from '#dist/shared/properties/variantRules.js';

// The gate runs every suite from the repository root.
const BUTTON = fs.readFileSync('test/fixtures/variantRules/Button.astro', 'utf8');

const NAMED = [
  'const named = {',
  '  play: pressed ? "Pause" : "Play",',
  '  close: "Close",',
  '  arrow: direction === "back" ? "Previous" : "Next",',
  '};',
].join('\n');

function replaced(source: string, replacements: readonly (readonly [string, string])[]): string {
  let output = source;
  for (const [from, to] of replacements) {
    assert.equal(output.split(from).length, 2, `expected exactly one ${JSON.stringify(from)}`);
    output = output.replace(from, () => to);
  }
  return output;
}

function component(frontmatter: string, template = '<div />'): string {
  return `---\n${frontmatter}\n---\n${template}\n`;
}

function tableOf(source: string, prop: string) {
  return readVariantDefaults(readPropertySyntax(source)).find((item) => item.prop === prop);
}

// The frontmatter still compiles as TypeScript: no syntax error in the written code.
function compiles(source: string): void {
  const frontmatter = readPropertySyntax(source).frontmatter;
  const output = ts.transpileModule(frontmatter, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext } });
  assert.deepEqual(
    (output.diagnostics ?? []).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    [],
  );
}

const BUTTON_ENTRIES: readonly VariantDefaultEntry[] = [
  { option: 'play', code: 'pressed ? "Pause" : "Play"' },
  { option: 'close', code: '"Close"' },
  { option: 'arrow', code: 'direction === "back" ? "Previous" : "Next"' },
];

test('the Button label reads as its table, keyed by variant, from the template', () => {
  assert.ok(BUTTON.includes(NAMED), 'the fixture holds the table');
  assert.deepEqual(tableOf(BUTTON, 'label'), { kind: 'table', prop: 'label', controller: 'variant', key: 'variant', table: 'named', entries: BUTTON_ENTRIES });
  // And it survives the wire with the rest of the panel's read.
  const read = readComponentProperties(BUTTON);
  assert.deepEqual(parseComponentProperties(JSON.parse(JSON.stringify(read))).variantDefaults, read.variantDefaults);
});

const TABLE_EDITS: readonly {
  readonly name: string;
  readonly entries: readonly VariantDefaultEntry[];
  readonly replacements: readonly (readonly [string, string])[];
}[] = [
  { name: 'unchanged entries keep every byte', entries: BUTTON_ENTRIES, replacements: [] },
  {
    name: 'a changed value replaces that value only',
    entries: BUTTON_ENTRIES.map((entry) => (entry.option === 'close' ? { ...entry, code: '"Dismiss"' } : entry)),
    replacements: [['  close: "Close",', '  close: "Dismiss",']],
  },
  {
    name: 'a value made conditional is written as its chain',
    entries: BUTTON_ENTRIES.map((entry) => (entry.option === 'close' ? { ...entry, code: 'pressed ? "Shut" : "Close"' } : entry)),
    replacements: [['  close: "Close",', '  close: pressed ? "Shut" : "Close",']],
  },
  {
    name: 'a new option is appended in the table layout',
    entries: [...BUTTON_ENTRIES, { option: 'main', code: '"Go"' }],
    replacements: [['  arrow: direction === "back" ? "Previous" : "Next",\n};', '  arrow: direction === "back" ? "Previous" : "Next",\n  main: "Go",\n};']],
  },
  {
    name: 'a dropped option goes with its line',
    entries: BUTTON_ENTRIES.filter((entry) => entry.option !== 'close'),
    replacements: [['  close: "Close",\n', '']],
  },
  {
    name: 'the last option dropped keeps the trailing comma style',
    entries: BUTTON_ENTRIES.filter((entry) => entry.option !== 'arrow'),
    replacements: [['  close: "Close",\n  arrow: direction === "back" ? "Previous" : "Next",\n};', '  close: "Close",\n};']],
  },
];

for (const row of TABLE_EDITS) {
  test(`setDefaultTable: ${row.name}`, () => {
    const result = editVariantDefaultTable(BUTTON, 'variant', 'label', row.entries);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    assert.equal(result.value, replaced(BUTTON, row.replacements));
    compiles(result.value);
    const read = tableOf(result.value, 'label');
    assert.ok(read?.kind === 'table');
    assert.deepEqual(read.entries, row.entries);
  });
}

test('a one-line table with single quotes takes new entries on its line', () => {
  const source = component(
    ["type Props = { tone?: 'calm' | 'loud'; label?: string };", "const { tone = 'calm', label } = Astro.props;", "const WORDS = { calm: 'Hush' };"].join('\n'),
    '<b>{label ?? WORDS[tone]}</b>',
  );
  const read = tableOf(source, 'label');
  assert.ok(read?.kind === 'table');
  assert.deepEqual(read.entries, [{ option: 'calm', code: "'Hush'" }]);
  const result = editVariantDefaultTable(source, 'tone', 'label', [...read.entries, { option: 'loud', code: "'Hey'" }]);
  assert.ok(result.ok);
  assert.equal(result.value, replaced(source, [["{ calm: 'Hush' }", "{ calm: 'Hush', loud: 'Hey' }"]]));
});

test('a table read in the frontmatter is read the same as one read in the template (Callout)', () => {
  const source = component(
    [
      'type Variant = "note" | "important";',
      'interface Props { variant?: Variant; label?: string }',
      'const { variant = "note", label } = Astro.props;',
      'const DEFAULT_LABEL: Record<Variant, string> = { note: "Note", important: "Important" };',
      'const heading = label ?? DEFAULT_LABEL[variant];',
    ].join('\n'),
  );
  // A table with a written type is the author's contract: it is code, not a table the panel edits.
  assert.deepEqual(tableOf(source, 'label'), { kind: 'computed', prop: 'label', code: 'DEFAULT_LABEL[variant]' });
  const untyped = source.replace(': Record<Variant, string>', '');
  assert.equal(tableOf(untyped, 'label')?.kind, 'table');
});

const COMPUTED: readonly { readonly name: string; readonly line: string; readonly code: string }[] = [
  { name: 'a table entry read further (Input, Select)', line: 'const text = label ?? KINDS[variant].label;', code: 'KINDS[variant].label' },
  { name: 'a call', line: 'const text = label ?? labelFor(variant);', code: 'labelFor(variant)' },
  { name: 'a table indexed by something that is not a prop', line: 'const text = label ?? KINDS[other];', code: 'KINDS[other]' },
];

for (const row of COMPUTED) {
  test(`computed, read-only: ${row.name}`, () => {
    const source = component(
      [
        'interface Props { variant?: "a" | "b"; label?: string }',
        'const { variant = "a", label } = Astro.props;',
        'const KINDS = { a: { label: "A" } };',
        row.line,
      ].join('\n'),
    );
    assert.deepEqual(tableOf(source, 'label'), { kind: 'computed', prop: 'label', code: row.code });
  });
}

test('no fallback, no default: plain reads and locals that are not props are not defaults', () => {
  const source = component(
    ['interface Props { label?: string }', 'const { label } = Astro.props;', 'const other = undefined;', 'const x = other ?? "y";'].join('\n'),
  );
  assert.deepEqual(readVariantDefaults(readPropertySyntax(source)), []);
});

test('refusals leave the bytes alone: bad code, a missing table, an entry read directly', () => {
  const bad = editVariantDefaultTable(BUTTON, 'variant', 'label', [{ option: 'play', code: '"Play' }]);
  assert.equal(bad.ok, false);
  const missing = editVariantDefaultTable(BUTTON, 'variant', 'emphasis', BUTTON_ENTRIES);
  assert.equal(missing.ok, false);
  const direct = BUTTON.replace('const content =', 'const playWords = named.play;\nconst content =');
  const read = editVariantDefaultTable(direct, 'variant', 'label', BUTTON_ENTRIES.slice(1));
  assert.equal(read.ok ? '' : read.error.code, 'in-use');
});

test('the edit crosses the wire, and a table with repeated options does not', () => {
  const edit = { kind: 'setDefaultTable', controller: 'variant', prop: 'label', entries: BUTTON_ENTRIES };
  assert.deepEqual(parseVariantRuleEdit(edit), edit);
  assert.throws(() => parseVariantRuleEdit({ ...edit, entries: [...BUTTON_ENTRIES, BUTTON_ENTRIES[0]] }));
  assert.throws(() => parseVariantRuleEdit({ ...edit, prop: 'variant' }));
});

test('a conditional destructure default moves its entry after the props it reads', () => {
  const label = readComponentProperties(BUTTON).properties.find((property) => property.name === 'label');
  assert.ok(label !== undefined);
  const code = 'variant === "play" && pressed ? "Pause" : variant === "play" ? "Play" : undefined';
  const result = editPropertyDefinition(BUTTON, { kind: 'save', originalName: 'label', property: { ...label, defaultValue: code } });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value, replaced(BUTTON, [['  label,\n  pressed = false,\n', `  pressed = false,\n  label = ${code},\n`]]));
  compiles(result.value);
  assert.equal(readComponentProperties(result.value).properties.find((property) => property.name === 'label')?.defaultValue, code);
});

test('a default that reads only earlier props stays where it is; one that would pass ...rest is refused', () => {
  const source = component('const { size = "s", label = size === "s" ? "Small" : "Large", ...rest } = Astro.props;');
  const kept = orderDefaultReads(source, 'label', ['size', 'label']);
  assert.ok(kept.ok);
  assert.equal(kept.value, source);
  const rest = component('const { label = rest.x ? "A" : "B", ...rest } = Astro.props;');
  const refused = orderDefaultReads(rest, 'label', ['label']);
  assert.equal(refused.ok ? '' : refused.error.code, 'default-order');
});

test('each option reads its own tooltip for the prop; a forbidden one has none', () => {
  const variant = readComponentProperties(BUTTON).variantGroups?.find((group) => group.controller === 'variant');
  assert.ok(variant !== undefined);
  const index = variant.props.indexOf('label');
  assert.deepEqual(
    variant.options.map((option) => [option.value, option.rules[index]?.description]),
    [
      ['main', ''],
      ['link', ''],
      ['play', 'Accessible label. Defaults to `Play` or `Pause`.'],
      ['close', 'Accessible label. Defaults to `Close`.'],
      ['arrow', 'Accessible label. Defaults to `Next` or `Previous`.'],
    ],
  );
});

test('a conditional default that reads a prop the destructure does not take takes it first', () => {
  const source = component(['interface Props { variant?: "a" | "b"; label?: string }', 'const { label } = Astro.props;'].join('\n'));
  const label = readComponentProperties(source).properties.find((property) => property.name === 'label');
  assert.ok(label !== undefined);
  const code = 'variant === "b" ? "Bee" : undefined';
  const result = editPropertyDefinition(source, { kind: 'save', originalName: 'label', property: { ...label, defaultValue: code } });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value, replaced(source, [['const { label } = Astro.props;', `const { variant, label = ${code} } = Astro.props;`]]));
  compiles(result.value);
});

// Goal: the scan reads a prop's type the way TypeScript means it, so the
// instance panel picks the right control: an action or an `any` is set in
// code, an object is not a list, a mixed union keeps its choices, an
// `as const` list is a choice, and a destructure annotated inline, a nested
// object type or a quoted member name are read as written.
//
// Methodology: small components, one shape each, run through parsePropSchema
// (the schema projection of the prop model, electron/parse/propModel/)
// the way the prop zoo (test/renderer/props/propZoo.test.js) runs whole files.
// `normalizeType` below is the old text classifier's contract, now answered by
// the model for a prop declared with that type, so the pinned table of type
// → kind still holds after the regex reader was retired. Each case also checks
// the negative space next to it: the nearby shape that must NOT change.
// Run on its own with `node test/electron/parse/propTypeReading.test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parsePropSchema, parseExtendsTag } = require('#dist/electron/parse/astroParser.js');
const { shownTypeText } = require('#dist/shared/properties/propModelSchema.js');

const schema = (frontmatter, template = '<div />') => parsePropSchema(`---\n${frontmatter}\n---\n${template}`);
const field = (frontmatter, name, template) => schema(frontmatter, template).find((entry) => entry.name === name);

// The kind a prop declared with `typeText` reads as: type, options, numeric,
// expression options and code kind, each only when it is set.
function normalizeType(typeText) {
  const read = field(`interface Props {\n  x: ${typeText};\n}`, 'x');
  assert.ok(read, `x is read from ${typeText}`);
  const out = { type: read.type };
  if (read.numeric) {
    out.numeric = true;
  }
  if (read.options !== undefined) {
    out.options = read.options;
  }
  if (read.expressionOptions !== undefined) {
    out.expressionOptions = read.expressionOptions;
  }
  if (read.codeKind !== undefined) {
    out.codeKind = read.codeKind;
  }
  return out;
}

test('functions and types no field can fill are code-only', () => {
  assert.deepEqual(normalizeType('(item: T) => string'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('() => void'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('(() => void) | undefined'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('<T>(value: T) => T'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('Function'), { type: 'other', codeKind: 'function' });
  for (const opaque of ['any', 'unknown', 'object', '{}', 'symbol', 'bigint', 'Promise<string[]>', 'Map<string, number>']) {
    assert.deepEqual(normalizeType(opaque), { type: 'other', codeKind: 'opaque' }, opaque);
  }
  // Negative space: a parenthesised union is not a function (it is the
  // union inside, which the syntax tree opens), and a named type is not opaque.
  assert.deepEqual(normalizeType("('a' | 'b')"), { type: 'enum', options: ['a', 'b'] });
  assert.deepEqual(normalizeType('ImageMetadata'), { type: 'other' });
  assert.deepEqual(normalizeType('string | (() => string)'), { type: 'string' });
});

test('objects are objects, arrays and tuples are lists, readonly or not', () => {
  assert.deepEqual(normalizeType('{ dense: boolean }'), { type: 'code', codeKind: 'object' });
  assert.deepEqual(normalizeType("{ filterFor: 'ALL' | 'ANY'; fields: { fieldPath: string }[] }"), { type: 'code', codeKind: 'object' });
  assert.deepEqual(normalizeType('readonly [min: number, max: number]'), { type: 'code' });
  assert.deepEqual(normalizeType('[number, number]'), { type: 'code' });
  assert.deepEqual(normalizeType('readonly string[]'), { type: 'code' });
  assert.deepEqual(normalizeType('ReadonlyArray<string>'), { type: 'code' });
  assert.deepEqual(normalizeType('{ title: string }[]'), { type: 'code' });
  assert.deepEqual(normalizeType('Record<string, string>'), { type: 'attrs' });
});

test('unions of literals are choices, mixed ones included', () => {
  assert.deepEqual(normalizeType("'sm' | 'md'"), { type: 'enum', options: ['sm', 'md'] });
  assert.deepEqual(normalizeType('1 | 2 | 3'), { type: 'enum', numeric: true, options: ['1', '2', '3'] });
  assert.deepEqual(normalizeType("boolean | 'auto'"), { type: 'enum', options: ['true', 'false', 'auto'], expressionOptions: ['true', 'false'] });
  assert.deepEqual(normalizeType("'sm' | 'lg' | number"), { type: 'enum', options: ['sm', 'lg'] });
  assert.deepEqual(normalizeType("'none' | 0 | 1"), { type: 'enum', options: ['none', '0', '1'], expressionOptions: ['0', '1'] });
  // Negative space: nothing to choose from, or any number at all.
  assert.deepEqual(normalizeType('true | false'), { type: 'boolean' });
  assert.deepEqual(normalizeType('boolean | undefined'), { type: 'boolean' });
  assert.deepEqual(normalizeType('number | 1 | 2'), { type: 'number' });
  assert.deepEqual(normalizeType("'only' | number"), { type: 'other' });
  assert.deepEqual(normalizeType('string | number'), { type: 'string' });
});

test('a function type does not unbalance the members after it', () => {
  const fields = schema('interface Props { format?: (value: number) => string; onSelect?: () => void; label: string }');
  assert.deepEqual(
    fields.map((entry) => [entry.name, entry.type, entry.codeKind]),
    [
      ['format', 'other', 'function'],
      ['onSelect', 'other', 'function'],
      ['label', 'string', undefined],
    ],
  );
});

test('a nested object type written over lines stays one member', () => {
  const names = schema(
    'interface Props {\n  cta: {\n    // The words.\n    label: string;\n    link: { href: string; external?: boolean };\n  };\n  /** Shown. */\n  open?: boolean;\n}',
  );
  assert.deepEqual(
    names.map((entry) => [entry.name, entry.type, entry.doc]),
    [
      ['cta', 'code', undefined],
      ['open', 'boolean', 'Shown.'],
    ],
  );
  assert.deepEqual(
    schema('interface Props {\n  cta: {\n    label: string;\n    link: { href: string };\n  };\n}').map((entry) => entry.name),
    ['cta'],
  );
});

test('quoted member names are props', () => {
  const fields = schema(
    "interface Props {\n  'data-id': string;\n  \"aria-label\"?: string;\n}\nconst { 'data-id': dataId, 'aria-label': ariaLabel = 'Zoo' } = Astro.props;",
  );
  assert.deepEqual(
    fields.map((entry) => [entry.name, entry.type, entry.optional, entry.default]),
    [
      ['data-id', 'string', false, undefined],
      ['aria-label', 'string', true, 'Zoo'],
    ],
  );
});

test('as const lists and enum-like objects are choices', () => {
  const size = field(
    "const SIZES = ['sm', 'md', 'lg'] as const;\ninterface Props { size?: (typeof SIZES)[number] }\nconst { size = 'md' } = Astro.props;",
    'size',
  );
  assert.deepEqual([size.type, size.options, size.default], ['enum', ['sm', 'md', 'lg'], 'md']);
  assert.deepEqual(field("const S = ['a', 'b'] as const;\ninterface Props { x: typeof S[number] }", 'x').options, ['a', 'b']);
  const values = field("const O = { A: 'a', B: 2 } as const;\ninterface Props { x: (typeof O)[keyof typeof O] }", 'x');
  assert.deepEqual([values.type, values.options, values.expressionOptions], ['enum', ['a', '2'], ['2']]);
  assert.deepEqual(field("const O = { A: 'a', B: 2 } as const;\ninterface Props { x: keyof typeof O }", 'x').options, ['A', 'B']);
  // Negative space: without `as const` the type is just string, and stays unread;
  // a list holding a name is not a list of literals.
  assert.equal(field("const S = ['a', 'b'];\ninterface Props { x: (typeof S)[number] }", 'x').type, 'other');
  assert.equal(field("const b = 'b';\nconst LOOSE = ['a', b] as const;\ninterface Props { x: (typeof LOOSE)[number] }", 'x').type, 'other');
});

test('the props destructure is found with an annotation, or through a holder', () => {
  const fields = schema('const { title, count = 1 }: { title: string; count?: number } = Astro.props;');
  assert.deepEqual(
    fields.map((entry) => [entry.name, entry.type, entry.optional, entry.default]),
    [
      ['title', 'string', false, undefined],
      ['count', 'number', true, 1],
    ],
  );
  const held = schema('const props = Astro.props;\nconst { title, level = 2 } = props;');
  assert.deepEqual(
    held.map((entry) => [entry.name, entry.default]),
    [
      ['title', undefined],
      ['level', 2],
    ],
  );
  // Negative space: other destructures are not the props; a holder's member is a prop it reads.
  assert.deepEqual(
    schema('const { a } = other;\nconst props = Astro.props;\nconst { b } = props.nested;').map((entry) => entry.name),
    ['nested'],
  );
});

test('defaults: escapes decoded, number formats read, templates with ${} kept as code', () => {
  const literals = schema(
    "const { quote = 'He said \\\"hi\\\"', lines = 'line one\\nline two', path = 'C:\\\\zoo', accent = 'caf\\u00e9 \\u{1F992}' } = Astro.props;",
  );
  assert.deepEqual(
    literals.map((entry) => entry.default),
    ['He said "hi"', 'line one\nline two', 'C:\\zoo', 'café 🦒'],
  );
  const numbers = schema('const { a = 1e3, b = 0x10, c = 1_000, d = -2.5, e = MAX * 2 } = Astro.props;');
  assert.deepEqual(
    numbers.map((entry) => [entry.default, entry.defaultExpr]),
    [
      [1000, undefined],
      [16, undefined],
      [1000, undefined],
      [-2.5, undefined],
      ['MAX * 2', true],
    ],
  );
  const fields = schema(
    "const SITE = 'Zoo';\ninterface Props { prefix?: string; plain?: string; joined?: string }\nconst { prefix = `${SITE}:`, plain = `just text`, joined = 'a' + SITE } = Astro.props;",
  );
  const byName = Object.fromEntries(fields.map((entry) => [entry.name, entry]));
  assert.deepEqual([byName.prefix.default, byName.prefix.defaultExpr], ['`${SITE}:`', true]);
  assert.deepEqual([byName.plain.default, byName.plain.defaultExpr], ['just text', undefined]);
  assert.deepEqual([byName.joined.default, byName.joined.defaultExpr], ["'a' + SITE", true]);
});

test('untyped defaults and reads say what a prop is', () => {
  const list = field("let { heading, items = ['one', 'two'] } = Astro.props;", 'items');
  assert.deepEqual([list.type, list.default], ['code', "['one', 'two']"]);
  const action = field('const { onPick = (item) => item } = Astro.props;', 'onPick');
  assert.equal(action.codeKind, 'function');
  const direct = schema('const year = Astro.props.year ?? 2026;', '<p>{Astro.props.label} {year}</p>');
  assert.deepEqual(
    direct.map((entry) => [entry.name, entry.type, entry.default]),
    [
      ['year', 'number', 2026],
      ['label', 'other', undefined],
    ],
  );
  // Negative space: with a Props type, a read is not a declaration.
  assert.deepEqual(
    schema('interface Props { title: string }', '<p>{Astro.props.title}{Astro.props.other}</p>').map((entry) => entry.name),
    ['title'],
  );
  const dated = field('interface Props {\n  /** Whether to show the date. Defaults to true. */\n  dated?: boolean;\n}', 'dated');
  assert.equal(dated.default, true);
});

test('a code-only prop carries its type text, bounded', () => {
  const action = field('interface Props { onSelect?: () => void }', 'onSelect');
  assert.deepEqual([action.codeKind, action.typeText], ['function', '() => void']);
  assert.equal(field('interface Props { title: string }', 'title').typeText, undefined);
  assert.equal(shownTypeText('{\n  a: string;\n}'), '{ a: string; }');
  assert.equal(shownTypeText('x'.repeat(2000)).length, 512);
});

test('a discriminated union hides what the other branch has', () => {
  const fields = schema("type Props =\n  | { kind: 'link'; href: string; label: string }\n  | { kind: 'button'; label: string; disabled?: boolean };");
  const branches = fields[0].unions[0].branches;
  assert.deepEqual(
    branches.map((branch) => [...branch.forbids].sort()),
    [['disabled'], ['href']],
  );
  // Negative space: a union no field tells apart forbids nothing it does not say.
  const loose = schema('type Props = { a: string } | { b: string; c: never };');
  assert.deepEqual(
    loose[0].unions[0].branches.map((branch) => branch.forbids),
    [[], ['c']],
  );
});

test('type Props = HTMLAttributes<tag> & {…} extends that tag', () => {
  assert.equal(parseExtendsTag("---\ntype Props = HTMLAttributes<'button'> & {\n  label: string;\n};\n---\n"), 'button');
  assert.equal(parseExtendsTag("---\ninterface Props extends HTMLAttributes<'a'> {}\n---\n"), 'a');
  assert.equal(parseExtendsTag("---\ntype Props = { attrs: HTMLAttributes<'div'> };\n---\n"), undefined);
});

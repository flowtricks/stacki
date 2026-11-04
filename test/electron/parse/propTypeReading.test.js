// Goal: the scan reads a prop's type the way TypeScript means it, so the
// instance panel picks the right control: an action or an `any` is set in
// code, an object is not a list, a mixed union keeps its choices, an
// `as const` list is a choice, and a destructure annotated inline, a nested
// object type or a quoted member name are read as written.
//
// Methodology: the pure readers (normalizeType, explodeMembers,
// resolveConstTypeQueries, propsDestructure, the literal decoders) are called
// directly on known-good and known-bad text; parsePropSchema is then run on
// small components, one shape each, the way the prop zoo
// (test/renderer/props/propZoo.test.js) runs whole files. Each case also checks
// the negative space next to it: the nearby shape that must NOT change.
// Run on its own with `node test/electron/parse/propTypeReading.test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeType,
  explodeMembers,
  splitTypeTop,
  resolveConstTypeQueries,
  constLiteralLists,
  memberName,
  shownTypeText,
} = require('#dist/electron/parse/astroPropTypes.js');
const { propsDestructure, decodeStringLiteral, numericLiteral } = require('#dist/electron/parse/astroPropFields.js');
const { parsePropSchema, parseExtendsTag } = require('#dist/electron/parse/astroParser.js');

const schema = (frontmatter, template = '<div />') => parsePropSchema(`---\n${frontmatter}\n---\n${template}`);
const field = (frontmatter, name, template) => schema(frontmatter, template).find((entry) => entry.name === name);

test('functions and types no field can fill are code-only', () => {
  assert.deepEqual(normalizeType('(item: T) => string'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('() => void'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('(() => void) | undefined'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('<T>(value: T) => T'), { type: 'other', codeKind: 'function' });
  assert.deepEqual(normalizeType('Function'), { type: 'other', codeKind: 'function' });
  for (const opaque of ['any', 'unknown', 'object', '{}', 'symbol', 'bigint', 'Promise<string[]>', 'Map<string, number>']) {
    assert.deepEqual(normalizeType(opaque), { type: 'other', codeKind: 'opaque' }, opaque);
  }
  // Negative space: a parenthesised union is not a function, and a named type is not opaque.
  assert.deepEqual(normalizeType("('a' | 'b')"), { type: 'other' });
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
  assert.deepEqual(splitTypeTop('format?: (value: number) => string; onSelect?: () => void; label: string', ';'), [
    'format?: (value: number) => string',
    'onSelect?: () => void',
    'label: string',
  ]);
});

test('a nested object type written over lines stays one member', () => {
  const block =
    '\n  cta: {\n    // The words.\n    label: string;\n    link: { href: string; external?: boolean };\n  };\n  /** Shown. */\n  open?: boolean;\n';
  const lines = explodeMembers(block)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(lines.length, 3, JSON.stringify(lines));
  assert.match(lines[0], /^cta: \{\s+label: string;\s+link: \{ href: string; external\?: boolean \};\s+\}$/);
  assert.equal(lines[1], '/** Shown. */');
  const names = schema('interface Props {\n  cta: {\n    label: string;\n    link: { href: string };\n  };\n}').map((entry) => entry.name);
  assert.deepEqual(names, ['cta']);
});

test('quoted member names are props', () => {
  assert.equal(memberName("'data-id'"), 'data-id');
  assert.equal(memberName('title'), 'title');
  assert.equal(memberName('"aria-label"'), 'aria-label');
  assert.throws(() => memberName(''), /Assertion failed: memberName/);
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
  const lists = constLiteralLists("const SIZES = ['sm', 'md'] as const;\nconst Tone = { Info: 'info', Warn: 'warn' } as const;\nconst LOOSE = ['a', b];");
  assert.deepEqual([...lists.keys()], ['SIZES', 'Tone']);
  assert.equal(lists.get('Tone').asConst, true);
  assert.equal(resolveConstTypeQueries("const S = ['a', 'b'] as const;\ntype T = (typeof S)[number];"), "const S = ['a', 'b'] as const;\ntype T = 'a' | 'b';");
  assert.equal(resolveConstTypeQueries("const S = ['a', 'b'] as const;\ntype T = typeof S[number];"), "const S = ['a', 'b'] as const;\ntype T = 'a' | 'b';");
  assert.equal(
    resolveConstTypeQueries("const O = { A: 'a', B: 2 } as const;\ntype V = (typeof O)[keyof typeof O];\ntype K = keyof typeof O;"),
    'const O = { A: \'a\', B: 2 } as const;\ntype V = \'a\' | 2;\ntype K = "A" | "B";',
  );
  // Negative space: without `as const` the type is just string, and stays unresolved.
  assert.equal(resolveConstTypeQueries("const S = ['a', 'b'];\ntype T = (typeof S)[number];"), "const S = ['a', 'b'];\ntype T = (typeof S)[number];");
  const size = field(
    "const SIZES = ['sm', 'md', 'lg'] as const;\ninterface Props { size?: (typeof SIZES)[number] }\nconst { size = 'md' } = Astro.props;",
    'size',
  );
  assert.deepEqual([size.type, size.options, size.default], ['enum', ['sm', 'md', 'lg'], 'md']);
});

test('the props destructure is found with an annotation, or through a holder', () => {
  assert.deepEqual(propsDestructure('const { title, count = 1 }: { title: string; count?: number } = Astro.props;'), {
    pattern: ' title, count = 1 ',
    annotation: '{ title: string; count?: number }',
  });
  assert.deepEqual(propsDestructure('const { a }: Props = Astro.props;'), { pattern: ' a ', annotation: 'Props' });
  assert.deepEqual(propsDestructure('const props = Astro.props;\nconst { title, level = 2 } = props;'), {
    pattern: ' title, level = 2 ',
    annotation: undefined,
  });
  // Negative space: other destructures, and a member of the holder, are not the props.
  assert.equal(propsDestructure('const { a } = other;\nconst props = Astro.props;\nconst { b } = props.nested;'), undefined);
  const fields = schema('const { title, count = 1 }: { title: string; count?: number } = Astro.props;');
  assert.deepEqual(
    fields.map((entry) => [entry.name, entry.type, entry.optional, entry.default]),
    [
      ['title', 'string', false, undefined],
      ['count', 'number', true, 1],
    ],
  );
});

test('defaults: escapes decoded, number formats read, templates with ${} kept as code', () => {
  assert.equal(decodeStringLiteral('He said \\"hi\\"'), 'He said "hi"');
  assert.equal(decodeStringLiteral('line one\\nline two'), 'line one\nline two');
  assert.equal(decodeStringLiteral('C:\\\\zoo'), 'C:\\zoo');
  assert.equal(decodeStringLiteral('caf\\u00e9 \\u{1F992}'), 'café 🦒');
  assert.equal(numericLiteral('1e3'), 1000);
  assert.equal(numericLiteral('0x10'), 16);
  assert.equal(numericLiteral('1_000'), 1000);
  assert.equal(numericLiteral('-2.5'), -2.5);
  assert.equal(numericLiteral('MAX * 2'), undefined);
  assert.equal(numericLiteral('1..2'), undefined);
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

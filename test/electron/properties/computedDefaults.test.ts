// Goal: a default a component computes from its other props reaches the
// instance panel as code it can weigh: Button's `label ?? named[variant]` with
// its lookup table, a destructure default that is a ternary on another prop,
// and any other `prop ?? <code>`; while a literal default, a bare name and a
// `?? "words"` fallback stay the schema's plain default, and a prop with no
// such default carries nothing. The schema boundary keeps the code, the prop
// each local holds and the tables, and refuses every malformed shape.
// Method: table-driven over the Lumos Button fixture and small components in
// the corpus's shapes, read with the built main-process modules (#dist);
// then the shared parser (parseField) is fed the read output (known-good) and
// each known-bad shape in turn, pinning its message.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { computedDefaultsOf, withComputedDefaults } from '#dist/electron/properties/computedDefaults.js';
import { parsePropSchema } from '#dist/electron/parse/astroParser.js';
import { parseField } from '#dist/shared/properties/propSchema.js';

// The gate runs every suite from the repository root.
const BUTTON = fs.readFileSync('test/fixtures/lumos/components/Button.astro', 'utf8');

function component(frontmatter: readonly string[], template = '<span />'): string {
  return ['---', ...frontmatter, '---', template].join('\n');
}

test('Button: the label default is the named table indexed by variant, with every entry as code', () => {
  const label = computedDefaultsOf(BUTTON).get('label');
  assert.ok(label !== undefined, 'the label has a computed default');
  assert.equal(label.code, 'named[variant]');
  assert.equal(label.locals['variant'], 'variant');
  assert.equal(label.locals['pressed'], 'pressed');
  assert.equal(label.locals['className'], 'class', 'a renamed local names its prop');
  assert.deepEqual(label.tables, {
    named: { play: 'pressed ? "Pause" : "Play"', close: '"Close"', arrow: 'direction === "back" ? "Previous" : "Next"' },
  });
});

test('Button: only the label is computed; props with literal defaults keep them', () => {
  const schema = withComputedDefaults(parsePropSchema(BUTTON), BUTTON);
  const computed = schema.filter((field) => field.computedDefault !== undefined).map((field) => field.name);
  assert.deepEqual(computed, ['label']);
  const variant = schema.find((field) => field.name === 'variant');
  assert.equal(variant?.default, 'main');
  assert.equal(variant?.computedDefault, undefined);
});

const SHAPES: readonly {
  readonly name: string;
  readonly source: string;
  readonly prop: string;
  readonly code: string | undefined;
}[] = [
  {
    name: 'a destructure ternary on another prop',
    source: component(['const { variant = "main", label = variant === "play" ? "Play" : "Close" } = Astro.props;']),
    prop: 'label',
    code: 'variant === "play" ? "Play" : "Close"',
  },
  {
    name: 'a fallback chain in the frontmatter',
    source: component(['const { variant, label } = Astro.props;', 'const named = { play: "Play" };', 'const shown = label ?? named[variant];']),
    prop: 'label',
    code: 'named[variant]',
  },
  {
    name: 'a computed fallback that only the site can run',
    source: component(['const { title, slug } = Astro.props;', 'const path = slug ?? slugify(title);']),
    prop: 'slug',
    code: 'slugify(title)',
  },
  {
    name: 'a literal destructure default',
    source: component(['const { label = "Go" } = Astro.props;']),
    prop: 'label',
    code: undefined,
  },
  {
    name: 'a negative number default',
    source: component(['const { offset = -1 } = Astro.props;']),
    prop: 'offset',
    code: undefined,
  },
  {
    name: 'a bare name default, followed elsewhere',
    source: component(['import { SITE_TITLE } from "../consts";', 'const { title = SITE_TITLE } = Astro.props;']),
    prop: 'title',
    code: undefined,
  },
  {
    name: 'a fallback of plain words',
    source: component(['const { label } = Astro.props;', 'const shown = label ?? "Go";']),
    prop: 'label',
    code: undefined,
  },
  {
    name: 'a prop read with no fallback',
    source: component(['const { label } = Astro.props;'], '<span>{label}</span>'),
    prop: 'label',
    code: undefined,
  },
];

for (const shape of SHAPES) {
  test(`shape: ${shape.name}`, () => {
    const found = computedDefaultsOf(shape.source).get(shape.prop);
    assert.equal(found?.code, shape.code);
  });
}

test('a destructure default wins over a later fallback, as it runs first', () => {
  const source = component([
    'const { variant, label = variant === "x" ? "A" : "B" } = Astro.props;',
    'const named = { x: "C" };',
    'const shown = label ?? named[variant];',
  ]);
  assert.equal(computedDefaultsOf(source).get('label')?.code, 'variant === "x" ? "A" : "B"');
});

test('a table entry that indexes another table carries both tables', () => {
  const source = component([
    'const { variant, size, label } = Astro.props;',
    'const sized = { small: "S", large: "L" };',
    'const named = { play: sized[size], close: "Close" };',
    'const shown = label ?? named[variant];',
  ]);
  const found = computedDefaultsOf(source).get('label');
  assert.deepEqual(Object.keys(found?.tables ?? {}).sort(), ['named', 'sized']);
});

test('a component without a props destructure has no computed defaults', () => {
  assert.equal(computedDefaultsOf(component(['const label = Astro.props.label ?? "Go";'])).size, 0);
});

test('the schema boundary keeps a computed default as read', () => {
  const read = withComputedDefaults(parsePropSchema(BUTTON), BUTTON).find((field) => field.name === 'label');
  const wire: unknown = JSON.parse(JSON.stringify(read));
  const parsed = parseField(wire, 'label');
  assert.deepEqual(parsed.computedDefault, read?.computedDefault);
});

const BAD: readonly { readonly name: string; readonly computedDefault: unknown; readonly message: RegExp }[] = [
  { name: 'not an object', computedDefault: 'named[variant]', message: /label\.computedDefault: expected object/ },
  { name: 'empty code', computedDefault: { code: '  ', locals: {}, tables: {} }, message: /computedDefault\.code: expected non-empty string/ },
  { name: 'code not text', computedDefault: { code: 3, locals: {}, tables: {} }, message: /computedDefault\.code: expected string/ },
  { name: 'a local naming no prop', computedDefault: { code: 'a', locals: { a: 1 }, tables: {} }, message: /computedDefault\.locals\.a: expected string/ },
  { name: 'a table that is not an object', computedDefault: { code: 'a', locals: {}, tables: { named: 'x' } }, message: /tables\.named: expected object/ },
  { name: 'an entry that is not code', computedDefault: { code: 'a', locals: {}, tables: { named: { play: true } } }, message: /named\.play: expected string/ },
  {
    name: 'more tables than options',
    computedDefault: { code: 'a', locals: {}, tables: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`t${index}`, {}])) },
    message: /computedDefault\.tables: exceeds 256 tables/,
  },
];

for (const bad of BAD) {
  test(`the schema boundary refuses a computed default: ${bad.name}`, () => {
    const field = { name: 'label', type: 'string', optional: true, computedDefault: bad.computedDefault };
    assert.throws(() => parseField(field, 'label'), bad.message);
  });
}

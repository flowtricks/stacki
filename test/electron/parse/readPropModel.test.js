// Goal: the prop model's producer (electron/parse/propModel/readPropModel.ts)
// states the facts the schema never carried, and stays bounded on any input:
// whether a prop is declared or only read, whether the component reads it at
// all, why it has its control, its nullability, its tags, and the nesting and
// union bounds (PROP_MODEL_LIMITS) on types an agent can write.
//
// Method: small components, one shape each, read through readPropModel. Each
// case pairs the positive shape with the nearby one that must not change:
// a destructured prop beside an unread one, an escaping spread beside a
// precise read, a bound met beside the bound exceeded, and types that name
// themselves, which must end rather than loop.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readPropModel } = require('#dist/electron/parse/propModel/readPropModel.js');
const { PROP_MODEL_LIMITS } = require('#dist/shared/properties/propModel.js');

const read = (frontmatter, template = '<div />') => readPropModel(`---\n${frontmatter}\n---\n${template}`);
const prop = (frontmatter, name, template) => read(frontmatter, template).props.find((entry) => entry.name === name);

test('usage: read, unread, or unknowable when the props escape whole', () => {
  const model = read(
    'interface Props { title: string; subtitle?: string; tagline?: string }\nconst { title } = Astro.props;',
    '<p>{title}{Astro.props.tagline}</p>',
  );
  assert.deepEqual(
    model.props.map((entry) => [entry.name, entry.usage]),
    [
      ['title', 'read'],
      ['subtitle', 'unread'],
      ['tagline', 'read'],
    ],
  );
  // A holder's member is a read; a spread of the props is an escape.
  assert.equal(prop('interface Props { a?: string }\nconst props = Astro.props;\nconst shown = props.a;', 'a').usage, 'read');
  assert.equal(prop('interface Props { a?: string; b?: string }\nconst { a } = Astro.props;', 'b', '<Child {...Astro.props} />').usage, 'unknown');
  assert.equal(prop('interface Props { a?: string; b?: string }\nconst { a, ...rest } = Astro.props;', 'b').usage, 'unknown');
  assert.equal(prop("interface Props { 'data-id'?: string }", 'data-id', '<p>{Astro.props["data-id"]}</p>').usage, 'read');
});

test('declared or only read, and why the control is what it is', () => {
  const model = read('interface Props { title: string; image: ImageMetadata }\nconst { title, image = "x", extra = 3 } = Astro.props;');
  const by = Object.fromEntries(model.props.map((entry) => [entry.name, entry]));
  assert.deepEqual([by.title.declared, by.title.recognition], [true, { source: 'type' }]);
  // A name the syntax cannot settle takes its kind from its default, and says so.
  assert.deepEqual([by.image.control.kind, by.image.recognition.source], ['text', 'usage']);
  assert.deepEqual([by.extra.declared, by.extra.control.kind, by.extra.presence], [false, 'number', 'optional']);
  assert.equal(model.declaration, 'interface');
  assert.equal(read('const { a } = Astro.props;').declaration, 'none');
  assert.equal(read('const { a }: { a: string } = Astro.props;').declaration, 'annotation');
  assert.equal(read('type CardProps = { a: string };\nconst { a } = Astro.props as CardProps;').declaration, 'assertion');
  assert.equal(read('type Props = { a: string };').declaration, 'type');
  // An untyped direct read, with no default, is a fallback: nothing says what it is.
  assert.deepEqual(prop('', 'label', '<p>{Astro.props.label}</p>').recognition, { source: 'fallback' });
});

test('nullable, presence and the tags a doc comment states', () => {
  const model = read(
    'interface Props {\n  /** The heading. @deprecated Use label. @group Text @format color */\n  title: string | null;\n  count: number | undefined;\n  open?: boolean | undefined;\n}',
  );
  const by = Object.fromEntries(model.props.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    [by.title.nullable, by.title.tooltip, by.title.deprecated, by.title.group, by.title.format],
    [true, 'The heading.', 'Use label.', 'Text', 'color'],
  );
  assert.deepEqual([by.count.nullable, by.count.presence], [true, 'required']);
  assert.deepEqual([by.open.nullable, by.open.presence, by.open.deprecated], [false, 'optional', undefined]);
});

test('controls the schema only hinted at: callback signature, attribute tag, group fields', () => {
  const model = read(
    "import type { HTMLAttributes } from 'astro/types';\ninterface Cta { label: string; href?: string }\ninterface Props {\n  onPick?: (item: string) => void;\n  link?: HTMLAttributes<'a'>;\n  cta: Cta;\n  items: readonly Cta[];\n}",
  );
  const by = Object.fromEntries(model.props.map((entry) => [entry.name, entry]));
  assert.deepEqual(by.onPick.control, { kind: 'callback', signature: '(item: string) => void' });
  assert.deepEqual(by.link.control, { kind: 'attributes', tag: 'a' });
  assert.deepEqual(
    by.cta.control.fields.map((field) => [field.name, field.control.kind, field.presence]),
    [
      ['label', 'text', 'required'],
      ['href', 'text', 'optional'],
    ],
  );
  assert.deepEqual([by.items.control.kind, by.items.control.item.kind], ['list', 'group']);
  // An interface that extends a local one has the base's members first.
  const extended = prop('interface Base { id: string }\ninterface Cta extends Base { label: string }\ninterface Props { cta: Cta }', 'cta');
  assert.deepEqual(
    extended.control.fields.map((field) => field.name),
    ['id', 'label'],
  );
});

test('nesting stops at the bound: deeper objects are code, not walked', () => {
  const depth = PROP_MODEL_LIMITS.propNestingDepthMax;
  // `{ a: { a: … { a: string } } }`, nested `levels` deep.
  const nested = (levels) => `${'{ a: '.repeat(levels)}string${' }'.repeat(levels)}`;
  const within = prop(`interface Props { x: ${nested(depth)} }`, 'x');
  let control = within.control;
  for (let level = 0; level < depth; level++) {
    assert.equal(control.kind, 'group', `level ${level} is a group`);
    control = control.fields[0].control;
  }
  assert.equal(control.kind, 'text', 'the innermost member keeps its kind');
  let beyond = prop(`interface Props { x: ${nested(depth + 1)} }`, 'x').control;
  for (let level = 0; level < depth; level++) {
    beyond = beyond.fields[0].control;
  }
  assert.deepEqual(beyond, { kind: 'code', reason: 'nestingDepth' });
});

test('a union of more shapes than the bound is not modelled as variants', () => {
  const arms = (count) => Array.from({ length: count }, (_, index) => `{ kind: 'k${index}'; v${index}?: string }`).join(' | ');
  assert.equal(read(`type Props = ${arms(PROP_MODEL_LIMITS.propVariantsMax)};`).unions[0].branches.length, PROP_MODEL_LIMITS.propVariantsMax);
  const over = read(`type Props = ${arms(PROP_MODEL_LIMITS.propVariantsMax + 1)};`);
  assert.deepEqual(over.unions, []);
  assert.equal(over.props.find((entry) => entry.name === 'kind').control.kind, 'choice', 'the props are still read');
});

test('types that name themselves end instead of looping', () => {
  assert.deepEqual(prop('type A = readonly A;\ninterface Props { x: A }', 'x').control, { kind: 'code', reason: 'unrecognized' });
  assert.deepEqual(prop('type A = B;\ntype B = A;\ninterface Props { x: A }', 'x').control, { kind: 'code', reason: 'unrecognized' });
  const tree = prop('interface Tree { label: string; children?: Tree[] }\ninterface Props { tree: Tree }', 'tree').control;
  assert.equal(tree.kind, 'group');
  assert.deepEqual(tree.fields[1].control, { kind: 'list', item: { kind: 'code', reason: 'unrecognized' } });
  assert.deepEqual(
    read('interface A extends B { a: string }\ninterface B extends A { b: string }\ninterface Props extends A {}').props.map((entry) => entry.name),
    ['b', 'a'],
  );
});

test('the model of any component parses: the producer checks its own output', () => {
  // A deliberately odd component still yields a model parsePropModel accepts.
  const model = read(
    "const SIZES = ['sm', 'md'] as const;\ntype Size = (typeof SIZES)[number];\ninterface Props { size?: Size; [key: string]: unknown; method(): void; 'quoted-name'?: 1 | 2 }\nconst { size = 'sm', ...rest } = Astro.props;",
  );
  assert.deepEqual(
    model.props.map((entry) => [entry.name, entry.control.kind]),
    [
      ['size', 'choice'],
      ['quoted-name', 'choice'],
    ],
  );
});

test('a member of an object type states what it holds with a @format tag, on the line of the member before too', () => {
  const group = prop(
    'interface Props { items: readonly { title: string; /** @format color */ tint: string;\n  /** @format date */\n  day: string; /** @format */ other: string }[] }',
    'items',
  ).control.item;
  assert.deepEqual(
    group.fields.map((field) => [field.name, field.control.format]),
    [
      ['title', undefined],
      ['tint', 'color'],
      ['day', 'date'],
      ['other', undefined],
    ],
  );
  assert.equal(
    prop('interface Props { n: { /** @format color */ count: number } }', 'n').control.fields[0].control.kind,
    'number',
    'a tag on a number states nothing',
  );
});

test('a list nested as deep as a List property’s fields go is modelled, and the level past it is code', () => {
  const lists = (count) => `${'readonly { l: '.repeat(count)}string${' }[]'.repeat(count)}`;
  let control = prop(`interface Props { x: ${lists(3)} }`, 'x').control;
  for (let level = 0; level < 3; level++) {
    assert.equal(control.kind, 'list', `list ${level}`);
    control = control.item.fields[0].control;
  }
  assert.equal(control.kind, 'text');
  let beyond = prop(`interface Props { x: ${lists(4)} }`, 'x').control;
  for (let level = 0; level < 3; level++) {
    beyond = beyond.item.fields[0].control;
  }
  assert.equal(beyond.kind, 'list');
  assert.deepEqual(beyond.item, { kind: 'code', reason: 'nestingDepth' });
});

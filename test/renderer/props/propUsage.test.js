// Goal: the Properties panel flags exactly the props nothing in the component
// reads.
//
// Method: unusedProps over component files as text. Each case pins one way a
// prop is read (a markup binding, a renamed local, a rest spread, frontmatter
// code computing another value, `Astro.props.name`) and the negative space
// beside it: the prop's own declaration and destructure, plain words in the
// markup, a property of another value, a comment, and a style block that
// cannot see frontmatter values.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { unusedProps } = load('src/editor/propUsage.ts');

const file = (frontmatter, markup) => `---\n${frontmatter}\n---\n${markup}\n`;
const unused = (source, names) => [...unusedProps(source, names)].sort();

test('a prop bound in the markup is used, one only declared is not', () => {
  const source = file(
    'interface Props {\n  title?: string;\n  text?: string;\n}\nconst { title = "Hi", text } = Astro.props;',
    '<h2>{title}</h2>\n<p>text</p>',
  );
  assert.deepEqual(unused(source, ['title', 'text']), ['text'], 'the word “text” in the markup is not a read');
});

test('a renamed local is what is read', () => {
  const source = file('const { class: propClass, label: theLabel } = Astro.props;', '<div class={propClass}>label</div>');
  assert.deepEqual(unused(source, ['class', 'label']), ['label']);
});

test('spreads, class lists, conditions and loops read props', () => {
  const source = file(
    'const { items = [], variant, open, ...rest } = Astro.props;',
    '<ul class:list={["list", variant]} {...rest}>{open && items.map((item) => <li>{item.title}</li>)}</ul>',
  );
  assert.deepEqual(unused(source, ['items', 'variant', 'open']), []);
});

test('frontmatter code reading a prop counts; its own declaration does not', () => {
  const used = file('const { count = 1 } = Astro.props;\nconst label = `${count} items`;', '<p>{label}</p>');
  assert.deepEqual(unused(used, ['count']), []);
  const comment = file('const { count = 1 } = Astro.props;\n// count is shown later\n/* count */', '<p>none</p>');
  assert.deepEqual(unused(comment, ['count']), ['count'], 'a comment is not a read');
});

test('a property of another value, a style block and Astro.props reads', () => {
  const other = file('const { title } = Astro.props;', '<p>{post.title}</p><style>.title { color: red; }</style>');
  assert.deepEqual(unused(other, ['title']), ['title']);
  const vars = file('const { color } = Astro.props;', '<style define:vars={{ color }}>p { color: var(--color); }</style>');
  assert.deepEqual(unused(vars, ['color']), []);
  const direct = file('interface Props { heading?: string }', '<h1>{Astro.props.heading}</h1>');
  assert.deepEqual(unused(direct, ['heading', 'missing']), ['missing']);
});

// Goal: an attribute written `{name}` keeps passing the variable `name`.
//
//   node test/electron/parse/shorthandAttrs.test.js
//
// Method: `{alternates}` is shorthand for `alternates={alternates}`. The attribute scanner once
// skipped the braces as noise and read a bare `alternates`, which writes back as a boolean `true`.
// The preview's marked copy of a layout then handed a component `true` for a list, the component
// threw while rendering, and the dev server answered 200 with a truncated page: a black canvas
// with no error on screen. The checks below hold the parse, the byte-identical round trip of an
// untouched tag, the marked copy a preview compiles, and the negative space: an edited tag
// spells the shorthand out in full, and braces holding no identifier are never a shorthand prop.

const assert = require('node:assert/strict');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');

let checked = 0;
const check = (what, condition) => {
  checked++;
  assert.ok(condition, what);
};

const source = '---\nconst title = 1;\n---\n<Foo {title} a="1" {...rest} {x}></Foo>\n<Bar {title} />\n<Baz\n  {title}\n  b="2"\n/>\n';
const parsed = parsePage(source, { locs: true });
check('the page is editable', parsed.editable);
const [foo, bar] = parsed.model.nodes;
check('a shorthand is an expression of its own name', foo.props.title.type === 'expr' && foo.props.title.value === 'title');
check('every shorthand of a tag is kept', foo.props.x.type === 'expr' && foo.props.x.value === 'x');
check('a spread stays a spread', foo.props['...rest'].type === 'spread');
check('a lone shorthand is not a bare attribute', bar.props.title.type === 'expr');
check('an untouched page round-trips byte for byte', serializePage(parsed.model) === source);

const edited = parsePage(source, { locs: true });
const editedFoo = edited.model.nodes[0];
editedFoo.props.a = { type: 'string', value: '2' };
check('an edited tag writes the shorthand in full', serializePage(edited.model).includes('<Foo title={title} a="2" {...rest} x={x}></Foo>'));

const marked = serializePageMarked(parsed.model, '', { file: 'src/pages/x.astro', checksum: 'a'.repeat(64) }, source);
check('the marked copy never writes a bare identifier for a shorthand', !/<Foo title a=/.test(marked) && /title=\{title\}/.test(marked));

const odd = parsePage('<Foo {} {-} />\n', { locs: true });
check(
  'braces that hold no identifier never become a shorthand prop',
  odd.editable && Object.values(odd.model.nodes[0].props).every((prop) => prop.type !== 'expr'),
);

console.log(`shorthand-attrs: ${checked} passed  [parse, round trip, edit, marked copy, negative space]`);

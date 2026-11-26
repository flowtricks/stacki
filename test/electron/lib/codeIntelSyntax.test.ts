// Goal: the readers under code intelligence place a cursor and read styles correctly from text that is still being
// typed: what the cursor is in, which characters of an .astro file the printed TSX shares (UTF-16 offsets, surrogate
// pairs included), and which classes and variables a stylesheet declares at which scope.
// Method: the cursor is written into each case as `‸`; offsets are checked by reading the characters they point at.
import assert from 'node:assert/strict';
import test from 'node:test';
import { astroDocument } from '#dist/electron/lib/codeIntel/astroDocument.js';
import { markupContext } from '#dist/electron/lib/codeIntel/markupContext.js';
import { colorValue, dialectFor, styleSymbols } from '#dist/electron/lib/codeIntel/styleSyntax.js';

function at(marked: string) {
  const offset = marked.indexOf('‸');
  assert.ok(offset >= 0, 'the case marks its cursor');
  return markupContext(marked.replace('‸', ''), offset);
}

test('the cursor is placed in each part of an .astro file', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['---\nconst a = ‸\n---\n<p></p>', 'frontmatter'],
    ['<p>text ‸here</p>', 'text'],
    ['<div><Wel‸</div>', 'tag-name'],
    ['<‸', 'tag-name'],
    ['<Card ‸/>', 'attribute-name'],
    ['<Card tone="a" ti‸', 'attribute-name'],
    ['<Card tone="‸"></Card>', 'attribute-value'],
    ['<Card tone=‸', 'attribute-value'],
    ['<p>{items.‸}</p>', 'expression'],
    ['<Card title={`a ${b}‸`} />', 'expression'],
    ['<ul>{list.map((x) => <li class="‸" />)}</ul>', 'attribute-value'],
    ['<ul>{list.map((x) => (\n  <Card ‸ />\n))}</ul>', 'attribute-name'],
    ['<ul>{a < b‸}</ul>', 'expression'],
    ['{open && <‸', 'tag-name'],
    ['<!-- <Card ‸ -->', 'comment'],
    ['<script>\nconst a = "<p"; ‸\n</script>', 'script'],
    ['<style lang="scss">\n.a { ‸ }\n</style>', 'style'],
    ['<script>const a = "<div";</script>\n<Card ‸/>', 'attribute-name'],
    ['<style>a{}</style>\n<p>‸</p>', 'text'],
  ];
  for (const [source, kind] of cases) {
    assert.equal(at(source).kind, kind, source);
  }
});

test('an attribute context names its tag, its attribute and what is already written', () => {
  const value = at('<Card.Title data-a="1" tone="lo‸" />');
  assert.ok(value.kind === 'attribute-value');
  assert.deepEqual([value.tag, value.attribute], ['Card.Title', 'tone']);
  const name = at('<Card a="1" b={2} c ‸ />');
  assert.ok(name.kind === 'attribute-name');
  assert.deepEqual([...name.written], ['a', 'b', 'c']);
});

test('offsets survive printing: every mapped cursor and range reads the same characters', () => {
  const source = '---\nconst wave = "👋 héllo";\n---\n<p title="😀">😀 {wave.length}</p>\n<Card tone="loud" />\n';
  const printed = astroDocument(source, '/site/src/a.astro');
  for (const needle of ['wave =', 'wave.length', 'length', 'tone=', 'loud']) {
    const offset = source.indexOf(needle) + needle.length;
    const generated = printed.toGenerated(offset);
    assert.ok(generated !== undefined, needle);
    assert.equal(printed.code.slice(generated - needle.length, generated), needle);
    const back = printed.toOriginal(generated - needle.length, generated);
    assert.deepEqual(back, { from: offset - needle.length, to: offset }, needle);
  }
  // Printed scaffolding maps nowhere.
  const scaffold = printed.code.indexOf('export default function');
  assert.equal(printed.toOriginal(scaffold, scaffold + 6), undefined);
});

test('a half-typed file still prints', () => {
  for (const source of ['<Card ti', '---\nconst a = {\n---\n<div', '<div>{ foo. }</div>', '<Card title="a" ', '<']) {
    assert.doesNotThrow(() => astroDocument(source, '/site/a.astro'), source);
  }
});

test('styles: variables, classes and scope are read from CSS and SCSS', () => {
  const sheet = [
    ':root { --brand: #f50; --gap : calc(1rem + 2px) !important; }',
    '/* .commented { --no: 1 } */',
    '// .also-commented {}',
    '@media (min-width: 40em) { .wide, .tall:hover > .deep[data-x=".no"] { margin: .5em } }',
    '.local :global(.shared) { background: url("a.b.png"); content: ".nope"; }',
    '$space: 4px;',
    '.icon-#{$name} { color: red }',
    '@import "./other";',
  ].join('\n');
  const symbols = styleSymbols(sheet, dialectFor('scss', { global: false }));
  assert.deepEqual(
    symbols.variables.map((entry) => [entry.name, entry.value.replace(' !important', '')]),
    [
      ['--brand', '#f50'],
      ['--gap', 'calc(1rem + 2px)'],
    ],
  );
  assert.deepEqual(
    symbols.classes.map((entry) => [entry.name, entry.global]),
    [
      ['wide', false],
      ['tall', false],
      ['deep', false],
      ['local', false],
      ['shared', true],
    ],
  );
  assert.deepEqual(
    symbols.preprocessorVariables.map((entry) => entry.name),
    ['$space'],
  );
  assert.deepEqual(symbols.imports, [{ specifier: './other', rule: 'import' }]);
  // In plain CSS `//` is not a comment, and a global sheet's names are global.
  const plain = styleSymbols('a { background: url(//cdn/x.png) } .b {}', dialectFor('css', { global: true }));
  assert.deepEqual(
    plain.classes.map((entry) => [entry.name, entry.global]),
    [['b', true]],
  );
});

test('only colours get a swatch', () => {
  for (const value of ['#fff', '#11223344', 'rgb(0 0 0)', 'oklch(60% 0.2 250)', 'tomato-not', 'white']) {
    assert.equal(colorValue(value) !== undefined, value !== 'tomato-not', value);
  }
  for (const value of ['1rem', 'var(--a)', 'url(x.png)', 'rgb(var(--a))']) {
    assert.equal(colorValue(value), undefined, value);
  }
});

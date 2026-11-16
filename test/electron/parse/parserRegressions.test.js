// Goal: pin parser fixes that each once broke a real page — empty frontmatter
// fences, closing-fence suffixes, prototype-looking attribute names, unknown
// entities, and package attribution on Windows and pnpm paths.
// Method: one minimal source per regression runs through the built parser and
// helpers; each assertion states the behavior that used to be wrong.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, serializePage, parseAttrs } = require('#dist/electron/parse/astroParser.js');
const { decodeEntities, encodeText } = require('#dist/shared/page/htmlText.js');
const { packageOf } = require('#dist/electron/lib/installedPackages.js');

test('empty frontmatter closes before body text beginning with dashes', () => {
  const source = '---\n---\n--- this belongs to the page\n<p>Text</p>\n';
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  assert.equal(parsed.model.extraFrontmatter, '');
  assert.equal(serializePage(parsed.model), source);
  assert.equal(parsePage('---\r\n---\r\n<p>x</p>').model.extraFrontmatter, '');
});

test('closing-fence trailing spaces are kept apart from the page, and text after the fence opens as code', () => {
  const parsed = parsePage('---\nconst note = 1;\n--- \t\n<p>Text</p>\n');
  assert.equal(parsed.editable, true);
  assert.equal(parsed.model.extraFrontmatter, 'const note = 1;');
  assert.equal(parsePage('---\nconst note = 1;\n--- \t\n<p>Text</p>').model.hadFrontmatter, true);
  // The compiler eats a character of text that follows the fence on its line, so the editor will not read it.
  assert.equal(parsePage('---\nconst note = 1;\n---body text\n<p>Text</p>\n').editable, false);
});

test('prototype-looking names remain ordinary own attributes', () => {
  const props = parseAttrs(' __proto__="kept" constructor="also kept" toString={label}');
  assert.equal(Object.getPrototypeOf(props), Object.prototype);
  assert.deepEqual(Object.keys(props), ['__proto__', 'constructor', 'toString']);
  assert.deepEqual(props.__proto__, { type: 'string', value: 'kept' });
  const source = '<div __proto__="kept" constructor="also kept">Text</div>\n';
  assert.equal(serializePage(parsePage(source).model), source);
});

test('unknown entities never resolve through Object.prototype', () => {
  for (const entity of ['&constructor;', '&toString;', '&valueOf;', '&hasOwnProperty;']) {
    assert.equal(decodeEntities(entity), entity);
  }
  const characters = 'a & b < c > d    ‌‍­©';
  assert.equal(decodeEntities(encodeText(characters)), characters);
});

test('package attribution handles Windows, nested dependencies, and pnpm', () => {
  assert.equal(packageOf('C:\\site\\node_modules\\@scope\\cards\\Page.astro'), '@scope/cards');
  assert.equal(packageOf('/site/node_modules/outer/node_modules/inner/Page.astro'), 'inner');
  assert.equal(packageOf('/site/node_modules/.pnpm/@scope+cards@1.0/node_modules/@scope/cards/Page.astro'), '@scope/cards');
  assert.equal(packageOf('/site/mynode_modules/not-a-package/Page.astro'), undefined);
  assert.equal(packageOf('node_modules/package/Page.astro'), 'package');
});

test('an expression attribute ending in a line comment is written with its brace on a new line', () => {
  const source = '<div data-y={a // trailing comment }\n}>x</div>\n';
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  const written = serializePage(parsed.model);
  assert.ok(/\/\/ trailing comment \}\n\}/.test(written), written);
  assert.ok(!/comment \}\}/.test(written), 'the comment never swallows the closing brace');
  const plain = parsePage('<div data-y={a}>x</div>\n');
  assert.equal(serializePage(plain.model), '<div data-y={a}>x</div>\n');
});

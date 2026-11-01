// A component's props as its Astro.props destructure lists them.
//
//   node test/electron/parse/destructureDefaults.test.js
//
// A builder's export gives a component a filters prop whose default is the
// filter itself: `filters: propFilters = {"filterFor": "ALL", "fields":
// [{"fieldPath": "image", "operatorName": "exists", "value": ""}]}`. The
// destructure was read with patterns over its whole text, so every key and
// value inside that default (fields, fieldPath, image, exists…) came back as a
// prop of its own, and a page using the component showed seven empty fields.
// Entries are now split at top-level commas only. Checked here: nested
// objects and lists, strings holding commas, braces and `//`, comments above
// an entry, renames and a rest element.

const assert = require('node:assert/strict');
const { parsePropSchema } = require('#dist/electron/parse/astroParser.js');

const names = (frontmatter) => parsePropSchema(`---\n${frontmatter}\n---\n<div />`).map((field) => field.name);
const field = (frontmatter, name) => parsePropSchema(`---\n${frontmatter}\n---\n<div />`).find((entry) => entry.name === name);

const exported = [
  'const {',
  '  paddingTop: propPaddingTop = "large",',
  '  /** Show the button, */',
  '  showButton: propShowButton = true,',
  '  filters: propFilters = {"filterFor": "ALL", "fields": [{"fieldPath": "image", "operatorName": "exists", "value": ""}, {"fieldPath": "name", "operatorName": "exists", "value": ""}]}',
  '} = Astro.props;',
].join('\n');
assert.deepEqual(names(exported), ['paddingTop', 'showButton', 'filters'], 'a nested default holds no props');
assert.equal(field(exported, 'paddingTop').default, 'large');
assert.equal(field(exported, 'showButton').default, true);
assert.equal(field(exported, 'filters').defaultExpr, true);
assert.match(field(exported, 'filters').default, /^\{"filterFor"/);

const tricky = [
  'const {',
  '  href = "https://example.com/a,b",',
  '  label = \'say "hi", then {go}\',',
  '  sizes = [1, 2, 3],',
  '  class: className = "",',
  '  // A line comment, with a comma.',
  '  count = 3,',
  '  ...rest',
  '} = Astro.props;',
].join('\n');
assert.deepEqual(names(tricky), ['href', 'label', 'sizes', 'class', 'count']);
assert.equal(field(tricky, 'href').default, 'https://example.com/a,b', 'a // inside a string is not a comment');
assert.equal(field(tricky, 'label').default, 'say "hi", then {go}');
assert.equal(field(tricky, 'count').default, 3);

console.log('destructure-defaults: ok');

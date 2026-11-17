// Goal: the Navigator names an `if` in short words a designer reads at a
// glance ("if Variant = Play", "if Render and Is Written…"), never longer than
// its bound and cut with an ellipsis, with the test as written as its tooltip;
// code the reader cannot delimit keeps the code as its label; and the words are
// translated (German says "wenn … und …").
//
// Method: the pure label module, bundled as the app bundles it, over a table
// of real tests (Lumos Button's among them) and
// the invalid edge: a regular expression, a very long test, blank code.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const labels = load('src/ui/conditionLabel.ts');

test('each test reads as short words, the test itself as the tooltip', () => {
  const table = [
    ['variant === "play"', 'if Variant = Play'],
    ['variant !== "close"', 'if Variant ≠ Close'],
    ['render && (isWritten ? content : true)', 'if Render and Is Written…'],
    ['!hidden || count > 3', 'if not Hidden or Count is greater than 3'],
    ['["main", "link"].includes(variant)', 'if Variant is any of Main, Link'],
    ['image?.url', 'if Image Url'],
    ['items.length > 0', 'if Items is not empty'],
    ['variant === "home-platform"', 'if Variant = home-platform'],
  ];
  for (const [source, label] of table) {
    const described = labels.conditionLabel(source);
    assert.equal(described.label, label, source);
    assert.equal(described.title, source, `the tooltip is the code: ${source}`);
  }
});

test('a long test is cut at the bound with an ellipsis, and code that cannot be read keeps its code', () => {
  const long = labels.conditionLabel('render && showContent && (name || title || company) && variant === "main"');
  assert.ok(long.label.length <= labels.CONDITION_LABEL_LENGTH_MAX, long.label);
  assert.ok(long.label.endsWith('…'), long.label);
  assert.equal(labels.conditionLabel('/^a/.test(title)').label, 'if /^a/.test(title)', 'unreadable code is its own label');
  assert.equal(labels.conditionLabel('a \n &&   b').title, 'a && b', 'the tooltip is on one line');
  assert.equal(labels.conditionLabel('').label, 'if ', 'a node with no test yet');
});

test('the words follow the language', () => {
  // The German catalog's words for the four keys the label uses.
  const translate = (key, values) => {
    const catalog = {
      'structure.cond.if': 'wenn {condition}',
      'structure.cond.and': 'und',
      'structure.cond.or': 'oder',
      'structure.cond.not': 'nicht {subject}',
    };
    const text = catalog[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  assert.equal(labels.conditionLabel('render && !hidden', translate).label, 'wenn Render und nicht Hidden');
  assert.equal(labels.nameWords('card.fluted'), 'Card Fluted');
  assert.equal(labels.nameWords('post.data["campus-name"]'), 'Post Data Campus Name');
});

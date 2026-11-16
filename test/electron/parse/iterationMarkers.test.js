// Goal: the marked copy of a page says which item of its list each pass of a
// loop is, so the editor can tell the card a node is in even when a condition
// leaves the node out of every other card.
//
// Methodology: a generated page (three cards, an Image only in the else branch
// of `card.fluted`) goes through the real parser and marked serializer. The
// comment expression the serializer writes for each pass is then evaluated, as
// the page's own render would, over generated data, and its output is read back
// with the shared parser. Checked: one marker per loop, naming the loop's own
// path; the item's place in the list it reads for a plain loop, a filtered and
// sorted one, a sliced one, a loop over Object.values; -1 for an item that
// appears twice; and no marker where the list is not a value the page names.
// Run on its own with `node test/electron/parse/iterationMarkers.test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parsePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const { iterationMarkerExpression, parseIterationMarker, iterationMarkerData } = require('#dist/shared/page/previewIteration.js');

const page = (frontmatter, body) => `---\n${frontmatter}\n---\n<main>\n${body}\n</main>\n`;
const marked = (source) => {
  const parsed = parsePage(source);
  assert.ok(parsed.editable, 'the generated page parses');
  return serializePageMarked(parsed.model, 'src/pages/index.astro');
};
// What a pass of the loop renders into the page's comment, over generated data.
const commentFor = (expression, scope) => {
  const names = Object.keys(scope);
  return new Function(...names, `return ${expression};`)(...names.map((name) => scope[name]));
};
const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('a loop writes one pass marker, naming its own path', () => {
  const out = marked(
    page(
      'const { platformIntro } = Astro.props;',
      '{platformIntro.cards.map((card) => (\n  <div>{card.fluted ? <FlutedImage src={card.image} /> : <Image src={card.image} />}</div>\n))}',
    ),
  );
  assert.equal(out.split('avb-i:').length - 1, 1, out);
  assert.ok(out.includes(':src/pages/index.astro0.0-->"'), 'the loop is the node whose own markers are avb-s:...0.0');
  assert.ok(out.includes('<!--avb-s:src/pages/index.astro0.0-->'));
});

test('the expression reads the item back as its place in the list', () => {
  const expression = iterationMarkerExpression('cards.map((card) => (', '0.0');
  assert.ok(expression);
  const read = (card) => parseIterationMarker(commentFor(expression, { cards, card }).slice('<!--'.length, -'-->'.length));
  assert.deepEqual(read(cards[2]), { path: '0.0', index: 2 });
  assert.deepEqual(read(cards[0]), { path: '0.0', index: 0 });
});

test('a filtered, sorted or sliced loop names the place in the list the picker shows', () => {
  for (const head of ['cards.filter((c) => c.id !== "a").map((card) => (', 'cards.toSorted().reverse().map((card) => (', 'cards.slice(1).map((card) => (']) {
    const expression = iterationMarkerExpression(head, '0.1');
    assert.ok(expression, head);
    const comment = commentFor(expression, { cards, card: cards[2] });
    assert.equal(parseIterationMarker(comment.slice(4, -3))?.index, 2, `${head}: item c is cards[2] whatever its rendered place`);
  }
});

test('Object.values loops count the object’s values', () => {
  const expression = iterationMarkerExpression('Object.values(modules).map((entry) => (', '0.2');
  assert.ok(expression);
  const modules = { x: 1, y: 2 };
  assert.equal(parseIterationMarker(commentFor(expression, { modules, entry: 2 }).slice(4, -3))?.index, 1);
});

test('what cannot be told apart says unknown, and never throws into the page', () => {
  const expression = iterationMarkerExpression('words.map((word) => (', '0.0');
  assert.ok(expression);
  const twice = commentFor(expression, { words: ['a', 'b', 'a'], word: 'a' });
  assert.equal(parseIterationMarker(twice.slice(4, -3))?.index, -1, 'an item that appears twice');
  const missing = commentFor(expression, { words: ['a'], word: 'z' });
  assert.equal(parseIterationMarker(missing.slice(4, -3))?.index, -1, 'an item that is not in the list');
  const broken = commentFor(expression, { words: undefined, word: 'a' });
  assert.equal(parseIterationMarker(broken.slice(4, -3))?.index, -1, 'a list that is not there');
});

test('no marker where the list is not a value the page names', () => {
  assert.equal(iterationMarkerExpression('getCards().map((card) => (', '0.0'), undefined);
  assert.equal(iterationMarkerExpression('not a loop', '0.0'), undefined);
});

test('the marker data round-trips and refuses what is not one', () => {
  assert.deepEqual(parseIterationMarker(iterationMarkerData('Card.astro|0.1', 4)), { path: 'Card.astro|0.1', index: 4 });
  assert.deepEqual(parseIterationMarker(iterationMarkerData('0.1', -1)), { path: '0.1', index: -1 });
  for (const bad of ['avb-s:0.1', 'avb-i:x:0.1', 'avb-i:-2:0.1', 'avb-i:1:', 'avb-i:1.5:0.1', '']) {
    assert.equal(parseIterationMarker(bad), undefined, bad);
  }
  assert.throws(() => iterationMarkerData('', 0), /a loop has a path/);
  assert.throws(() => iterationMarkerData('0', -2), /an item place/);
});

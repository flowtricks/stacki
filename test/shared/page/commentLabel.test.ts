// Goal: a CSS comment becomes a readable label. The Variables panel showed a
// docblock heading as "* The brand purple. `#9c75f7` i…": the gutter of the
// docblock's second line leaked into the title, and the backticks showed raw.
// Methodology: feed `commentLabel` the bodies postcss hands over (the text
// between the delimiters, trimmed) and the raw bodies a reader could hand it,
// and check the title, that the title is an exact span of the body (renaming
// writes there), and the description. Then the negative space: empty
// comments, stars that are words rather than gutters, sentence marks inside
// code, and the bounds. `labelParts` is checked for paired, unpaired and
// empty backticks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMENT_LABEL_LIMITS, commentLabel, labelParts, labelPlainText } from '#dist/shared/page/commentLabel.js';

// The span is the contract the rename relies on: always check it.
const label = (body: string) => {
  const result = commentLabel(body);
  assert.equal(body.slice(result.titleStart, result.titleEnd), result.title, `span of ${JSON.stringify(body)}`);
  return result;
};

test('a single-line comment is its own title, with no description', () => {
  const result = label('Swatches');
  assert.equal(result.title, 'Swatches');
  assert.equal(result.description, undefined);
  assert.equal(label(' Brand ').title, 'Brand');
});

test('a single-line comment of several sentences takes the first', () => {
  const result = label('Brand colours. Mixed from one base.');
  assert.equal(result.title, 'Brand colours');
  assert.equal(result.description, 'Brand colours. Mixed from one base.');
  // A closing full stop alone says nothing more.
  assert.equal(label('Brand colours.').title, 'Brand colours');
  assert.equal(label('Brand colours.').description, undefined);
});

test('a docblock loses its gutter on every line', () => {
  // As postcss hands it over: the body trimmed, so the first line starts at `*`.
  const body = '* The brand purple. `#9c75f7` is the base.\n   * The ramp is mixed from it.';
  const result = label(body);
  assert.equal(result.title, 'The brand purple');
  assert.equal(result.description, 'The brand purple. `#9c75f7` is the base.\nThe ramp is mixed from it.');
  assert.ok(!result.title.includes('*'));
});

test('a docblock with a blank first line takes its title from the first line with words', () => {
  const body = '\n   * Spacing scale\n   *\n   * Every step is a multiple of 4px.\n   ';
  const result = label(body);
  assert.equal(result.title, 'Spacing scale');
  assert.equal(result.description, 'Spacing scale\n\nEvery step is a multiple of 4px.');
  // A `/**` opener leaves a lone `*` as the first line: a gutter, not a title.
  assert.equal(label('*\n * Radii\n ').title, 'Radii');
});

test('backticks stay in the title as written, and a sentence mark in code does not end it', () => {
  const result = label('The `--brand-400` ramp. Do not edit by hand.');
  assert.equal(result.title, 'The `--brand-400` ramp');
  assert.equal(label('Use `a. b` here').title, 'Use `a. b` here');
  assert.equal(label('Widths in `rem`').title, 'Widths in `rem`');
});

test('a line with no sentence end is the title whole', () => {
  const result = label('Brand colours\n * picked by hand');
  assert.equal(result.title, 'Brand colours');
  assert.equal(result.description, 'Brand colours\npicked by hand');
});

test('questions, exclamations and ellipses keep their mark', () => {
  assert.equal(label('Why two greys? History.').title, 'Why two greys?');
  assert.equal(label('Careful! Shared.').title, 'Careful!');
  assert.equal(label('More to come...').title, 'More to come...');
  // A full stop inside a number or a name is not a sentence end.
  assert.equal(label('Use 0.5rem steps, e.g.small ones').title, 'Use 0.5rem steps, e.g.small ones');
});

test('stars that touch a word are the author’s, not a gutter', () => {
  assert.equal(label('*Deprecated* tokens').title, '*Deprecated* tokens');
  assert.equal(label('** Legacy').title, 'Legacy');
});

test('an empty comment has an empty title and no description', () => {
  for (const body of ['', '   ', '*', '\n * \n ']) {
    const result = label(body);
    assert.equal(result.title, '', JSON.stringify(body));
    assert.equal(result.description, undefined);
  }
  // A comment that is only a full stop keeps it: a title is never emptied.
  assert.equal(label('.').title, '.');
});

test('the description is bounded', () => {
  const long = `Title. ${'word '.repeat(COMMENT_LABEL_LIMITS.descriptionCharsMax)}`;
  const result = label(long);
  assert.equal(result.title, 'Title');
  assert.ok(result.description !== undefined);
  assert.equal(result.description.length, COMMENT_LABEL_LIMITS.descriptionCharsMax);
  assert.ok(result.description.endsWith('…'));
  // Lines past the bound are not read; the title still comes from the first.
  const many = `Many\n${' * line\n'.repeat(COMMENT_LABEL_LIMITS.linesMax * 2)}`;
  assert.equal(label(many).title, 'Many');
});

test('labelParts splits a title into text and code', () => {
  assert.deepEqual(labelParts('The brand purple'), [{ kind: 'text', text: 'The brand purple' }]);
  assert.deepEqual(labelParts('Base `#9c75f7` purple'), [
    { kind: 'text', text: 'Base ' },
    { kind: 'code', text: '#9c75f7' },
    { kind: 'text', text: ' purple' },
  ]);
  assert.deepEqual(labelParts('`--a` and `--b`'), [
    { kind: 'code', text: '--a' },
    { kind: 'text', text: ' and ' },
    { kind: 'code', text: '--b' },
  ]);
  // An unpaired backtick is text, joined to the text around it.
  assert.deepEqual(labelParts('A `b` c `d'), [
    { kind: 'text', text: 'A ' },
    { kind: 'code', text: 'b' },
    { kind: 'text', text: ' c `d' },
  ]);
  assert.deepEqual(labelParts('it`s'), [{ kind: 'text', text: 'it`s' }]);
  // An empty pair draws nothing.
  assert.deepEqual(labelParts('a `` b'), [{ kind: 'text', text: 'a  b' }]);
  assert.deepEqual(labelParts(''), []);
});

test('labelPlainText drops the backticks and keeps the words', () => {
  assert.equal(labelPlainText('Base `#9c75f7` purple'), 'Base #9c75f7 purple');
  assert.equal(labelPlainText('it`s'), 'it`s');
});

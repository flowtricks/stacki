// Goal: the demo shows a formatting press as Astro would render it. Wrapping words in
// <strong> splits the element's text, and the text left beside the new element keeps
// the space that separates the words.
// Method: the text half of a page change (editedText) is fed baked text and the source's
// new text: baked edge whitespace is kept, a new word gap becomes one space, and an
// emptied text keeps only the baked whitespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editedText } from '../demo/pageRender';

test('the text before a newly bold word keeps the space between the words', () => {
  assert.equal(editedText('Edit Astro sites visually', 'Edit Astro sites '), 'Edit Astro sites ');
  assert.equal(editedText('Edit Astro sites visually', ' sites visually'), ' sites visually');
});

test('the baked text’s own edge whitespace wins over the source’s layout', () => {
  assert.equal(editedText('\n  Heading\n', 'New heading'), '\n  New heading\n');
  assert.equal(editedText('\n  Heading\n', '\n        New heading\n      '), '\n  New heading\n');
  assert.equal(editedText('Heading', 'New heading'), 'New heading');
});

test('an emptied text keeps only the baked whitespace', () => {
  assert.equal(editedText(' Heading ', '   '), '  ');
  assert.equal(editedText('Heading', ''), '');
});

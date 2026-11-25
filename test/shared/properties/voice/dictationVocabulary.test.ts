// Goal: the person's words land as they write them, and nothing else changes. An explicit pair replaces
// its misheard phrase whole and case-insensitively; a near miss of five letters or more becomes the
// vocabulary word, keeping a sentence's capital; short words, numbers, addresses and words with digits
// are never touched. Snippets expand longest trigger first, ignoring case and punctuation, after an
// optional "insert"/"paste", with newlines kept, in one pass. Stored data is parsed with its bounds and a
// damaged entry is dropped while the rest stay.
// Methodology: the pure functions over dictated sentences, then known-bad stored shapes (negative space).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VOCABULARY_LIMITS,
  applyVocabulary,
  BUILT_IN_VOCABULARY,
  correctedWord,
  editDistance,
  expandSnippets,
  parseDictationWords,
  parseSnippet,
  parseVocabularyEntry,
} from '#dist/shared/properties/voice/dictationVocabulary.js';

// localStorage's JSON writes an absent field as null.
const storedNull: unknown = JSON.parse('null');
const vocabulary = [{ word: 'Stacki', misheard: 'stack ee' }, { word: 'Lumos' }, { word: 'Astro' }, { word: 'Tailwind' }, { word: 'kubernetes' }];

test('an explicit pair replaces its misheard phrase as a whole, whatever its case and punctuation', () => {
  assert.equal(applyVocabulary('Open Stack Ee and add a card.', vocabulary), 'Open Stacki and add a card.');
  assert.equal(applyVocabulary('open stack-ee.', vocabulary), 'open Stacki.');
  assert.equal(applyVocabulary('a haystack eel', vocabulary), 'a haystack eel', 'never inside other words');
});

test('a near miss becomes the vocabulary word, spelled as written', () => {
  assert.equal(applyVocabulary('Use the lumus framework.', vocabulary), 'Use the Lumos framework.');
  assert.equal(applyVocabulary('Add tailwinds.', vocabulary), 'Add Tailwind.');
  assert.equal(applyVocabulary('Kubernetis is next.', vocabulary), 'Kubernetes is next.', 'a lowercase entry takes the sentence capital');
  assert.equal(applyVocabulary('deploy kubernetees', vocabulary), 'deploy kubernetes');
});

test('short words, other real words, numbers and addresses are never changed', () => {
  assert.equal(applyVocabulary('An astro is a star.', [{ word: 'Astra' }]), 'An astro is a star.', 'five letters, one edit: changed only when within one');
  assert.equal(
    applyVocabulary('Set it to 12345 at https://lumus.example/path and lumus2.', vocabulary),
    'Set it to 12345 at https://lumus.example/path and lumus2.',
  );
  assert.equal(applyVocabulary('The tool is good.', vocabulary), 'The tool is good.');
  assert.equal(applyVocabulary('Mouse moves.', [{ word: 'Lumos' }]), 'Mouse moves.', 'two edits away from a five-letter word is too far');
  assert.equal(applyVocabulary('', vocabulary), '');
});

test('edit distance stops at its limit', () => {
  assert.equal(editDistance('lumus', 'lumos', 2), 1);
  assert.equal(editDistance('abcdef', 'uvwxyz', 1), 2);
  assert.throws(() => editDistance('a', 'b', -1), /never negative/);
});

const snippets = [
  { trigger: 'my linkedin', expansion: 'https://www.linkedin.com/in/example' },
  { trigger: 'my linkedin profile', expansion: 'LinkedIn: https://www.linkedin.com/in/example' },
  { trigger: 'signature', expansion: 'Thanks,\nTim' },
  { trigger: 'loop', expansion: 'loop loop' },
];

test('snippets expand longest first, ignoring case and punctuation, after an optional insert or paste', () => {
  assert.equal(expandSnippets('Here is my LinkedIn profile.', snippets), 'Here is LinkedIn: https://www.linkedin.com/in/example');
  assert.equal(expandSnippets('Here is my linkedin', snippets), 'Here is https://www.linkedin.com/in/example');
  assert.equal(expandSnippets('Insert signature.', snippets), 'Thanks,\nTim', 'the keyword goes with the trigger and newlines stay');
  assert.equal(expandSnippets('paste, my linkedin', snippets), 'https://www.linkedin.com/in/example');
  assert.equal(expandSnippets('A signatures file', snippets), 'A signatures file', 'whole phrases only');
  assert.equal(expandSnippets('loop', snippets), 'loop loop', 'one pass: an expansion is not expanded again');
});

test('stored words are parsed with their bounds; a damaged entry is dropped and the rest kept', () => {
  assert.deepEqual(parseVocabularyEntry({ word: ' Stacki ', misheard: 'stack ee' }), { word: 'Stacki', misheard: 'stack ee' });
  assert.deepEqual(parseVocabularyEntry({ word: 'Lumos', misheard: storedNull }), { word: 'Lumos' });
  for (const bad of [{ word: '' }, { word: 'x'.repeat(65) }, { word: 'two\nlines' }, { word: 3 }, { word: 'ok', misheard: '' }]) {
    assert.throws(() => parseVocabularyEntry(bad), /Expected/);
  }
  assert.throws(() => parseSnippet({ trigger: '...', expansion: 'x' }), /words/);
  assert.throws(() => parseSnippet({ trigger: 'a', expansion: 'x'.repeat(4_001) }), /expansion within/);
  assert.throws(() => parseSnippet({ trigger: 'a', expansion: '   ' }), /non-empty expansion/);
  const stored = parseDictationWords({
    vocabulary: [{ word: 'Stacki' }, { word: '' }, { word: 'stacki' }, 'Lumos', { word: 'Lumos' }],
    snippets: [{ trigger: 'sig', expansion: 'Tim' }, { trigger: 'SIG.', expansion: 'again' }, { trigger: 7 }],
  });
  assert.deepEqual(
    stored,
    { vocabulary: [{ word: 'Stacki' }, { word: 'Lumos' }], snippets: [{ trigger: 'sig', expansion: 'Tim' }] },
    'duplicates and damage dropped',
  );
  assert.deepEqual(parseDictationWords('nonsense'), { vocabulary: [], snippets: [] });
  const many = parseDictationWords({ vocabulary: Array.from({ length: 500 }, (_value, index) => ({ word: `word${index}` })), snippets: [] });
  assert.equal(many.vocabulary.length, VOCABULARY_LIMITS.entriesMax);
});

test('a single word changed right after dictation is offered for the vocabulary; anything else is not', () => {
  assert.deepEqual(correctedWord('Open the lumus page.', 'Fix this. Open the Lumos page.'), { heard: 'lumus', corrected: 'Lumos' });
  assert.equal(correctedWord('Open the lumus page.', 'Open the lumus page.'), undefined, 'nothing changed');
  assert.equal(correctedWord('Open the lumus page.', 'Close the Lumos page.'), undefined, 'two words changed');
  assert.equal(correctedWord('Open a page.', 'Open an page.'), undefined, 'short words teach nothing');
  assert.equal(correctedWord('Open the page', 'page'), undefined, 'the text is shorter than what was dictated');
});

test("Stacki's own names are corrected out of the box, as turbo mishears them", () => {
  assert.equal(applyVocabulary('Open Stacky and switch the Loomis theme.', BUILT_IN_VOCABULARY), 'Open Stacki and switch the Lumos theme.');
  assert.equal(applyVocabulary('Open stachy.', BUILT_IN_VOCABULARY), 'Open Stacki.');
});

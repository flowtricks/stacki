// Goal: words nobody said never reach the box. "Thank you." decoded from a short or quiet window is
// dropped, while a loud, long "thank you" is kept; a usual phrase stuck to the end or start of real words
// is dropped when there are more words than the speech could hold; repeated sentences are written once;
// a segment that repeats the end of the last one adds only its new words, and an identical one nothing.
// Methodology: the pure filters over real hallucinations reported in dictation ("Thank you. Okay. You
// This is a test. Thank you."), in English and German, with speech evidence on both sides of the bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collapseRepeats,
  filterHallucinations,
  isKnownHallucination,
  normalizePhrase,
  splitSentences,
  withoutOverlap,
} from '#dist/shared/properties/voice/hallucinations.js';

const quiet = { speechMs: 300, speechRms: 0.02, speechRatio: 0.3, meanProbability: 0.6, onset: true };
const loud = { speechMs: 1_500, speechRms: 0.12, speechRatio: 0.9, meanProbability: 0.95, onset: true };
const sentence = { speechMs: 1_300, speechRms: 0.1, speechRatio: 0.8, meanProbability: 0.9, onset: true };
const en = { language: 'en', continuing: false };
const said = (text: string, evidence: typeof loud, context = en): string => filterHallucinations(text, evidence, context).text;

test('phrases compare without case, punctuation or extra spaces', () => {
  assert.equal(normalizePhrase('  Thank   you!! '), 'thank you');
  assert.equal(isKnownHallucination('Thanks for watching!', 'en'), true);
  assert.equal(isKnownHallucination('Vielen Dank.', 'de'), true);
  assert.equal(isKnownHallucination('Okay.', 'fr'), true, 'the shared phrases apply to every language');
  assert.equal(isKnownHallucination('[Music]', 'en'), true);
  assert.equal(isKnownHallucination('Thank you for the fix.', 'en'), false);
});

test('a usual phrase from a short or quiet window is dropped; spoken clearly, it is kept', () => {
  assert.equal(said(' Thank you.', quiet), '');
  assert.equal(said('Okay. You', quiet), '');
  assert.equal(said(' Thanks for watching!', { ...loud, speechMs: 600 }), '', 'loud but too short');
  assert.equal(said(' Thank you.', { ...loud, speechRms: 0.02 }), '', 'long but too quiet');
  assert.equal(said('Thank you.', loud), 'Thank you.');
  assert.equal(said('Danke.', quiet, { language: 'de', continuing: false }), '');
});

test('a usual phrase stuck to real words is dropped when the words outrun the speech', () => {
  assert.equal(said('This is a test. Thank you.', sentence), 'This is a test.');
  assert.equal(said('Thank you. Okay. You. This is a test. Thank you.', sentence), 'This is a test.');
  assert.equal(said('This is a test, thank you for the patience.', sentence), 'This is a test, thank you for the patience.');
  const long = { ...sentence, speechMs: 4_000 };
  assert.equal(said('The header is done. Thank you.', long), 'The header is done. Thank you.', 'enough speech for every word');
});

test('repeated sentences are written once', () => {
  assert.deepEqual(collapseRepeats(splitSentences('Okay. Okay. Okay. Fix it.')), ['Okay.', 'Fix it.']);
  assert.equal(said('Fix the header. Fix the header.', sentence), 'Fix the header.');
  assert.deepEqual(splitSentences('一つ目。二つ目！'), ['一つ目。', '二つ目！']);
});

test('the words of the last segment are not written twice', () => {
  assert.equal(withoutOverlap('Make the heading larger', 'heading larger and blue'), 'and blue');
  assert.equal(withoutOverlap('Make the heading larger.', 'Make the heading larger.'), '', 'an identical segment adds nothing');
  assert.equal(withoutOverlap('', 'First words'), 'First words');
  assert.equal(withoutOverlap('Add a card', 'card table'), 'card table', 'one shared word is not an overlap');
});

test('the new phrases, the short-and-unsure rule and the onset rule leave out invented words, and say why', () => {
  for (const phrase of ["That's it.", 'That is all.', "I'm sorry.", 'Yeah.', 'Mm-hmm.', 'All right.', 'See you.', 'Good night.']) {
    assert.equal(said(phrase, quiet), '', phrase);
  }
  const unsure = { ...sentence, meanProbability: 0.55 };
  const result = filterHallucinations('Move it left.', unsure, en);
  assert.equal(result.text, '');
  assert.deepEqual(result.dropped, [{ text: 'Move it left.', reason: 'shortAndUnsure' }]);
  assert.equal(said('Move it left.', sentence), 'Move it left.', 'the same words with sure speech are kept');
  const noise = { ...sentence, onset: false };
  assert.deepEqual(filterHallucinations('The weather is nice today.', noise, en).dropped, [{ text: 'The weather is nice today.', reason: 'noOnset' }]);
  assert.equal(
    said('The weather is nice today.', noise, { language: 'en', continuing: true }),
    'The weather is nice today.',
    'speech continuing past a cut keeps its words',
  );
  assert.equal(said('This is a test.', sentence), 'This is a test.', 'real speech still lands');
});

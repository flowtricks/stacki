// Goal: a recognized phrase becomes what a person would have typed, and a phrase that must not
// change does not. Fillers and stutters go, a spoken correction replaces what it corrects,
// spoken punctuation becomes the mark, sentences start with a capital, and the dictionary writes
// names the way the project spells them.
// Methodology: the pure cleanup over known phrases, then the negative space: real vocabulary
// that looks like a filler or a marker ("like", "I mean", "that that"), phrases with nothing to
// clean, empty input, the capital that is withheld mid-sentence, and the parser that guards the boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript, rulesForLanguage, startsSentence } from '#dist/shared/properties/voice/transcriptCleanup.js';
import { parseTranscript } from '#dist/shared/properties/voice/transcript.js';
import { BUILT_IN_TERMS, entriesFromPaths, mergeDictionary } from '#dist/shared/properties/voice/voiceDictionary.js';
import { VOICE_LIMITS } from '#dist/shared/properties/voice/voiceLimits.js';

const sentence = { capitalizeFirst: true, dictionary: [], rules: 'english' } as const;
const midSentence = { capitalizeFirst: false, dictionary: [], rules: 'english' } as const;

test('fillers and stuttered words are removed', () => {
  assert.equal(cleanTranscript('um so the the button uh is red', sentence), 'So the button is red');
  assert.equal(cleanTranscript('hmm i think er it works', sentence), 'I think it works');
});

test('a filler that carried the pause mark leaves the mark on the word before it', () => {
  assert.equal(cleanTranscript('so, um, the header', sentence), 'So, the header');
});

test('real vocabulary is never removed: like, repeated "had" and "that", numbers', () => {
  assert.equal(cleanTranscript('it looks like a card', sentence), 'It looks like a card');
  assert.equal(cleanTranscript('the code that that returns had had a bug', sentence), 'The code that that returns had had a bug');
  assert.equal(cleanTranscript('set it to 5 5', sentence), 'Set it to 5 5');
  assert.equal(cleanTranscript('i mean it is fine', sentence), 'I mean it is fine');
});

test('a spoken correction replaces the words it corrects, back to the start of the sentence at most', () => {
  assert.equal(cleanTranscript('meet at five no wait six', sentence), 'Meet at six');
  assert.equal(cleanTranscript('meet me at the cafe no wait at the library', sentence), 'Meet me at the library');
  assert.equal(cleanTranscript('use blue or rather green', sentence), 'Use green');
  assert.equal(cleanTranscript('fix it. paint it red no wait blue', sentence), 'Fix it. Paint it blue');
});

test('a correction marker with nothing after it is kept as the words it is', () => {
  assert.equal(cleanTranscript('there is nothing to do no wait', sentence), 'There is nothing to do no wait');
});

test('spoken punctuation becomes the mark on the word before it', () => {
  assert.equal(cleanTranscript('hello comma world period', sentence), 'Hello, world.');
  assert.equal(cleanTranscript('is it done question mark yes exclamation point', sentence), 'Is it done? Yes!');
  assert.equal(cleanTranscript('first colon one semicolon two full stop', sentence), 'First: one; two.');
});

test('a punctuation word with nothing before it, or after a mark already there, stays a word', () => {
  assert.equal(cleanTranscript('period of the animation', sentence), 'Period of the animation');
  assert.equal(cleanTranscript('hello. comma', sentence), 'Hello. Comma');
});

test('"i" and its contractions are capitalized, words that merely start with i are not', () => {
  assert.equal(cleanTranscript("i'm sure i've seen it and i'll fix it, is it fine", midSentence), "I'm sure I've seen it and I'll fix it, is it fine");
  assert.equal(cleanTranscript('icon in the index', midSentence), 'icon in the index');
});

test('the first letter is capitalized only when the phrase starts a sentence', () => {
  assert.equal(cleanTranscript('and then it works', midSentence), 'and then it works');
  assert.equal(cleanTranscript('and then it works', sentence), 'And then it works');
  assert.equal(startsSentence(''), true);
  assert.equal(startsSentence('Fix the bug.'), true);
  assert.equal(startsSentence('Fix the bug.   '), true);
  assert.equal(startsSentence('Line one\n'), true);
  assert.equal(startsSentence('Fix the bug in'), false);
});

test('an empty or all-filler phrase cleans to nothing', () => {
  assert.equal(cleanTranscript('', sentence), '');
  assert.equal(cleanTranscript('   ', sentence), '');
  assert.equal(cleanTranscript('um uh er', sentence), '');
});

test('the dictionary writes project names, longest entry first, keeping the punctuation around them', () => {
  const dictionary = mergeDictionary(entriesFromPaths(['src/components/HeroSection.astro', 'src/components/Hero.astro', 'src/styles/site-header.css']));
  assert.equal(
    cleanTranscript('open the hero section dot astro file', { capitalizeFirst: false, dictionary, rules: 'english' }),
    'open the HeroSection.astro file',
  );
  assert.equal(
    cleanTranscript('move the hero section, then the site header.', { capitalizeFirst: false, dictionary, rules: 'english' }),
    'move the HeroSection, then the site-header.',
  );
  assert.equal(cleanTranscript('use state and type script', { capitalizeFirst: false, dictionary, rules: 'english' }), 'useState and TypeScript');
  // A sentence start keeps the written name exactly: "useState" is not capitalized into "UseState".
  assert.equal(cleanTranscript('use state is a hook', { capitalizeFirst: true, dictionary, rules: 'english' }), 'useState is a hook');
});

test('parseTranscript accepts text and refuses everything else', () => {
  assert.deepEqual(parseTranscript('  hello  '), { ok: true, value: 'hello' });
  assert.deepEqual(parseTranscript(42), { ok: false, error: 'not-text' });
  assert.deepEqual(parseTranscript(undefined), { ok: false, error: 'not-text' });
  assert.deepEqual(parseTranscript('x'.repeat(VOICE_LIMITS.utteranceCharsMax + 1)), { ok: false, error: 'too-long' });
  assert.equal(parseTranscript('x'.repeat(VOICE_LIMITS.utteranceCharsMax)).ok, true);
});

test('a phrase longer than the word bound is cut, never looped over without end', () => {
  const long = Array.from({ length: VOICE_LIMITS.utteranceWordsMax + 200 }, (_, index) => `word${index}`).join(' ');
  const cleaned = cleanTranscript(long, midSentence);
  assert.equal(cleaned.split(' ').length, VOICE_LIMITS.utteranceWordsMax);
});

test('the built-in terms are lower-case spoken forms within the bounds', () => {
  for (const entry of BUILT_IN_TERMS) {
    assert.ok(entry.spoken.length > 0 && entry.spoken.length <= VOICE_LIMITS.dictionarySpokenWordsMax, entry.written);
    assert.ok(
      entry.spoken.every((word) => word === word.toLowerCase() && !word.includes(' ')),
      entry.written,
    );
  }
});

test('another language gets the dictionary only: English rule words are left alone', () => {
  const dictionary = mergeDictionary(entriesFromPaths(['src/components/HeroSection.astro']));
  const other = { capitalizeFirst: true, dictionary, rules: 'dictionary' } as const;
  assert.equal(cleanTranscript('ich habe er um period comma', other), 'ich habe er um period comma');
  assert.equal(cleanTranscript('abre hero section por favor', other), 'abre HeroSection por favor');
  assert.equal(rulesForLanguage('en-US'), 'english');
  assert.equal(rulesForLanguage('en'), 'english');
  assert.equal(rulesForLanguage('EN-gb'), 'english');
  assert.equal(rulesForLanguage('es'), 'dictionary');
  assert.equal(rulesForLanguage('pt-BR'), 'dictionary');
  assert.equal(rulesForLanguage('enm'), 'dictionary');
  assert.equal(rulesForLanguage(''), 'dictionary');
});

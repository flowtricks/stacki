// Goal: the dictionary follows the project: file names become what a person would say, matching
// is by whole words and never by pattern, and every list stays inside its bound.
// Methodology: name splitting and entry building over camelCase, kebab, snake and odd names,
// then the matcher over adversarial names (regex characters, repeated words, partial matches).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDictionary, entriesFromPaths, mergeDictionary, wordsOfName } from '#dist/shared/properties/voice/voiceDictionary.js';
import { VOICE_LIMITS } from '#dist/shared/properties/voice/voiceLimits.js';

test('a name splits at its joins into lower-case words', () => {
  assert.deepEqual(wordsOfName('HeroSection'), ['hero', 'section']);
  assert.deepEqual(wordsOfName('site-header'), ['site', 'header']);
  assert.deepEqual(wordsOfName('site_header_2'), ['site', 'header', '2']);
  assert.deepEqual(wordsOfName('HTMLParser'), ['html', 'parser']);
  assert.deepEqual(wordsOfName('---'), []);
});

test('files give entries for the name and for the name with its extension', () => {
  const entries = entriesFromPaths(['src/pages/index.astro', 'src/components/HeroSection.astro', 'README.md']);
  const written = entries.map((entry) => entry.written);
  assert.ok(written.includes('HeroSection'));
  assert.ok(written.includes('HeroSection.astro'));
  assert.ok(written.includes('README'));
  assert.ok(!written.includes('index'), 'a plain lower-case one-word name needs no entry');
});

test('a name with too many words, or too long, is left out', () => {
  assert.deepEqual(entriesFromPaths(['a/OneTwoThreeFourFiveSixSevenEight.astro']), []);
  assert.deepEqual(entriesFromPaths([`a/${'x'.repeat(VOICE_LIMITS.dictionaryWrittenCharsMax + 1)}Name.astro`]), []);
  assert.deepEqual(entriesFromPaths(['']), []);
});

test('the entry list never passes its bound', () => {
  const paths = Array.from(
    { length: VOICE_LIMITS.dictionaryEntriesMax * 2 },
    (_, index) => `src/Widget${String.fromCharCode(97 + (index % 26))}Name${index}.astro`,
  );
  assert.ok(entriesFromPaths(paths).length <= VOICE_LIMITS.dictionaryEntriesMax);
  assert.ok(mergeDictionary(entriesFromPaths(paths)).length <= VOICE_LIMITS.dictionaryEntriesMax);
});

test('matching is by whole words: a prefix, a suffix or a regex character matches nothing extra', () => {
  const dictionary = [
    { spoken: ['hero'], written: 'Hero' },
    { spoken: ['a', '+', 'b'], written: 'A+B' },
  ];
  assert.deepEqual(applyDictionary(['heroic', 'hero', 'superhero'], dictionary), ['heroic', 'Hero', 'superhero']);
  assert.deepEqual(applyDictionary(['aab'], dictionary), ['aab']);
  assert.deepEqual(applyDictionary([], dictionary), []);
});

test('the longest entry wins and punctuation stays outside the name', () => {
  const dictionary = [
    { spoken: ['hero'], written: 'Hero' },
    { spoken: ['hero', 'section'], written: 'HeroSection' },
  ];
  assert.deepEqual(applyDictionary(['(hero', 'section),', 'hero.'], dictionary), ['(HeroSection),', 'Hero.']);
});

test('a dictionary over the bound is a programmer error', () => {
  const tooMany = Array.from({ length: VOICE_LIMITS.dictionaryEntriesMax + 1 }, (_, index) => ({ spoken: [`w${index}`], written: `W${index}` }));
  assert.throws(() => applyDictionary(['w1'], tooMany), /the dictionary is bounded/u);
});

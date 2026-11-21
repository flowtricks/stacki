// The text the platform's speech recognizer hands over is a boundary value: it is checked
// once here, and everything after (cleanup, commands, the dictionary) works on a phrase whose
// type proves it is bounded text (AGENTS.md §2).
import { err, ok, type Result } from '../../core/result';
import { VOICE_LIMITS } from './voiceLimits';

export type TranscriptProblem = 'not-text' | 'too-long';

/** A recognized phrase: text with something in it, within the phrase bounds. */
export function parseTranscript(input: unknown): Result<string, TranscriptProblem> {
  if (typeof input !== 'string') {
    return err('not-text');
  }
  if (input.length > VOICE_LIMITS.utteranceCharsMax) {
    return err('too-long');
  }
  return ok(input.trim());
}

/** The words of a phrase, split on runs of white space; never more than the bound (the rest is the recognizer's fault, cut here). */
export function wordsOf(text: string): readonly string[] {
  const words = text.split(/\s+/u).filter((word) => word !== '');
  return words.slice(0, VOICE_LIMITS.utteranceWordsMax);
}

/** A word as it is compared: lower case, with the punctuation around it taken off. */
export function wordCore(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

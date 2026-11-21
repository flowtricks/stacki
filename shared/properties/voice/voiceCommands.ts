// Spoken commands for the chat box: "send", "new line", "scratch that". They are told apart
// from dictation by where they stand, because a command that fires inside a sentence would
// eat the sentence. A phrase that is only a command ("send") is a command, because the
// recognizer ends a phrase at a pause and a person who means the word in a sentence keeps
// talking. "new line" and "new paragraph" work inside a phrase (they only add a break), and
// "scratch that" inside a phrase drops the words said before it.
import { assert } from '../../core/assert';
import { wordCore, wordsOf } from './transcript';
import { VOICE_LIMITS } from './voiceLimits';

export type VoiceAction =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'newline'; readonly count: 1 | 2 }
  /** Take the last dictated piece back out of the box. */
  | { readonly kind: 'deleteLast' }
  | { readonly kind: 'send' }
  | { readonly kind: 'stop' };

const SEND: readonly (readonly string[])[] = [['send'], ['send', 'it'], ['send', 'message'], ['send', 'the', 'message'], ['submit']];
const STOP: readonly (readonly string[])[] = [
  ['stop', 'listening'],
  ['stop', 'dictating'],
  ['stop', 'dictation'],
];
const DELETE: readonly (readonly string[])[] = [
  ['delete', 'that'],
  ['scratch', 'that'],
  ['undo', 'that'],
  ['remove', 'that'],
];
const BREAKS: readonly { readonly spoken: readonly string[]; readonly count: 1 | 2 }[] = [
  { spoken: ['new', 'paragraph'], count: 2 },
  { spoken: ['new', 'line'], count: 1 },
  { spoken: ['newline'], count: 1 },
];

/** The actions a phrase asks for, in order. A phrase with no command is one `insert` of the phrase as it is. */
export function parseVoiceCommands(phrase: string): readonly VoiceAction[] {
  const words = wordsOf(phrase);
  if (words.length === 0) {
    return [];
  }
  const cores = words.map(wordCore);
  if (matchesWhole(cores, SEND)) {
    return [{ kind: 'send' }];
  }
  if (matchesWhole(cores, STOP)) {
    return [{ kind: 'stop' }];
  }
  if (matchesWhole(cores, DELETE)) {
    return [{ kind: 'deleteLast' }];
  }
  const actions: VoiceAction[] = [];
  let piece: string[] = [];
  const flush = (): void => {
    if (piece.length > 0) {
      actions.push({ kind: 'insert', text: piece.join(' ') });
      piece = [];
    }
  };
  let index = 0;
  while (index < words.length) {
    const lineBreak = BREAKS.find((candidate) => matchesAt(cores, index, candidate.spoken));
    const scratch = DELETE.find((candidate) => matchesAt(cores, index, candidate));
    if (lineBreak !== undefined) {
      flush();
      actions.push({ kind: 'newline', count: lineBreak.count });
      index += lineBreak.spoken.length;
    } else if (scratch !== undefined) {
      // Inside a phrase "scratch that" drops what was said since the last break in it.
      piece = [];
      index += scratch.length;
    } else {
      piece.push(words[index] ?? '');
      index += 1;
    }
  }
  flush();
  assert(actions.length <= words.length, 'parseVoiceCommands: no more actions than words');
  assert(words.length <= VOICE_LIMITS.utteranceWordsMax, 'parseVoiceCommands: the phrase is bounded');
  return actions;
}

function matchesAt(cores: readonly string[], index: number, phrase: readonly string[]): boolean {
  return phrase.every((part, offset) => cores[index + offset] === part);
}

function matchesWhole(cores: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  return phrases.some((phrase) => phrase.length === cores.length && matchesAt(cores, 0, phrase));
}

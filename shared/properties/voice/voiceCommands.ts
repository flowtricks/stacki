// Spoken commands for the chat box: "send", "new line", "scratch that". They are told apart
// from dictation by where they stand, because a command that fires inside a sentence would
// eat the sentence. A phrase that is only a command ("send") is a command, because the
// recognizer ends a phrase at a pause and a person who means the word in a sentence keeps
// talking. A break ("new line", "next line", "line break", "new paragraph") is a command at a
// phrase's edge: the whole phrase, its first words or its last words, which is where a pause puts
// it; inside a sentence ("add a new line of code") it is text. Every break is a paragraph break:
// one blank line, never more (`withParagraphBreak`). "scratch that" inside a phrase drops the
// words said before it.
import { assert } from '../../core/assert';
import { wordCore, wordsOf } from './transcript';
import { VOICE_LIMITS } from './voiceLimits';

export type VoiceAction =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'newline'; readonly count: 2 }
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
const BREAKS: readonly (readonly string[])[] = [['new', 'paragraph'], ['new', 'line'], ['next', 'line'], ['line', 'break'], ['newline']];
/** Newlines a paragraph break leaves at the end of the text: one blank line. */
const PARAGRAPH_NEWLINES = 2;

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
  const lineBreak = (): void => {
    // Breaks said one after another make one break: never more than a blank line.
    if (actions.at(-1)?.kind !== 'newline') {
      actions.push({ kind: 'newline', count: PARAGRAPH_NEWLINES });
    }
  };
  // Breaks at the start of the phrase, then at its end; what is between is text, breaks included.
  let start = 0;
  let end = words.length;
  for (let pass = 0; pass < words.length && start < end; pass += 1) {
    const found = BREAKS.find((candidate) => start + candidate.length <= end && matchesAt(cores, start, candidate));
    if (found === undefined) {
      break;
    }
    lineBreak();
    start += found.length;
  }
  const trailing: number[] = [];
  for (let pass = 0; pass < words.length && start < end; pass += 1) {
    const found = BREAKS.find((candidate) => end - candidate.length >= start && matchesAt(cores, end - candidate.length, candidate));
    if (found === undefined) {
      break;
    }
    trailing.push(found.length);
    end -= found.length;
  }
  for (let index = start; index < end;) {
    const scratch = DELETE.find((candidate) => index + candidate.length <= end && matchesAt(cores, index, candidate));
    if (scratch !== undefined) {
      // Inside a phrase "scratch that" drops what was said before it in the phrase.
      piece = [];
      index += scratch.length;
    } else {
      piece.push(words[index] ?? '');
      index += 1;
    }
  }
  flush();
  if (trailing.length > 0) {
    lineBreak();
  }
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

/** `text` ending in one paragraph break: trailing spaces removed, exactly two newlines, never more; nothing for an empty box. */
export function withParagraphBreak(text: string): string {
  const trimmed = text
    .replace(/[ \t]+$/u, '')
    .replace(/\n+$/u, (newlines) => newlines.slice(0, PARAGRAPH_NEWLINES))
    .replace(/[ \t]+\n/gu, '\n');
  if (trimmed.trim() === '') {
    return trimmed;
  }
  const result = trimmed.endsWith('\n'.repeat(PARAGRAPH_NEWLINES)) ? trimmed : `${trimmed.replace(/\n$/u, '')}${'\n'.repeat(PARAGRAPH_NEWLINES)}`;
  assert(
    !result.includes('\n'.repeat(PARAGRAPH_NEWLINES + 1)) || text.includes('\n'.repeat(PARAGRAPH_NEWLINES + 1)),
    'withParagraphBreak: never adds a third newline',
  );
  assert(result.endsWith('\n'), 'withParagraphBreak: the text ends in the break');
  return result;
}

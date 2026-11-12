// The pure model of a chip editor draft: text interleaved with chips (an @-mention of a
// file, a skill, a block of instructions). The editor holds a draft as one string in
// which each chip is a single placeholder character, plus the chips in the order they
// appear; this file converts between that and the segment list a caller stores, and
// finds the `@` trigger the cursor sits in. It knows nothing about what a chip is, so the
// chip type is a parameter, and nothing about CodeMirror, so it is tested as plain functions.
import { assert } from '../../../shared/core/assert';

/** The character that stands for one chip in the editor's document (the object replacement character). */
export const CHIP_CHARACTER = '￼';

// A draft is text, chip, text, chip... so n chips give at most 2n + 1 segments; 127 chips keep
// a draft within the 256 segments the AI panel stores (AI_LIMITS.composerSegmentsMax).
export const CHIP_COUNT_MAX = 127;
export const SEGMENTS_MAX = 2 * CHIP_COUNT_MAX + 1;
/** The longest query typed after the trigger that still counts as a search. */
export const TRIGGER_QUERY_CHARS_MAX = 64;

export type Segment<Chip> = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'chip'; readonly chip: Chip };

export interface ChipDocument<Chip> {
  readonly text: string;
  /** In the order their placeholders appear in `text`. */
  readonly chips: readonly Chip[];
}

/** The document a segment list becomes. Empty text segments are dropped. */
export function segmentsToDocument<Chip>(segments: readonly Segment<Chip>[]): ChipDocument<Chip> {
  assert(segments.length <= SEGMENTS_MAX, 'chip editor: too many segments');
  let text = '';
  const chips: Chip[] = [];
  for (const segment of segments) {
    if (segment.kind === 'chip') {
      text += CHIP_CHARACTER;
      chips.push(segment.chip);
    } else {
      assert(!segment.text.includes(CHIP_CHARACTER), 'chip editor: text segments hold no placeholder character');
      text += segment.text;
    }
  }
  assert(chips.length <= CHIP_COUNT_MAX, 'chip editor: too many chips');
  return { text, chips };
}

/** The segments of a document: runs of text between chips, never two text segments in a row. */
export function documentToSegments<Chip>(document: ChipDocument<Chip>): readonly Segment<Chip>[] {
  const pieces = document.text.split(CHIP_CHARACTER);
  assert(pieces.length - 1 === document.chips.length, 'chip editor: one chip per placeholder');
  const segments: Segment<Chip>[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const text = pieces[index];
    if (text !== undefined && text.length > 0) {
      segments.push({ kind: 'text', text });
    }
    const chip = document.chips[index];
    if (index < document.chips.length && chip !== undefined) {
      segments.push({ kind: 'chip', chip });
    }
  }
  assert(segments.length <= SEGMENTS_MAX, 'chip editor: segments within bounds');
  return segments;
}

export interface TriggerMatch {
  /** Offset of the trigger character within the text that was searched. */
  readonly offset: number;
  /** What was typed after the trigger. */
  readonly query: string;
}

/**
 * The trigger the cursor is inside, given the text before it on its line: a `trigger`
 * character at the start of the line or after whitespace or a chip, followed by no whitespace.
 * "a@b" (an address) and "@a b" (the word ended) are not triggers.
 */
export function findTrigger(textBeforeCursor: string, trigger: string): TriggerMatch | undefined {
  assert(trigger.length === 1, 'findTrigger: the trigger is one character');
  let start = textBeforeCursor.length;
  while (start > 0) {
    const previous = textBeforeCursor.charAt(start - 1);
    if (/\s/u.test(previous) || previous === CHIP_CHARACTER) {
      break;
    }
    start -= 1;
  }
  const word = textBeforeCursor.slice(start);
  if (!word.startsWith(trigger)) {
    return undefined;
  }
  const query = word.slice(1);
  if (query.length > TRIGGER_QUERY_CHARS_MAX) {
    return undefined;
  }
  return { offset: start, query };
}

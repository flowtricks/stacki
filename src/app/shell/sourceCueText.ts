// The words of the source cue, as pure text: the path a bound text writes to, cut
// at its START when long. The file's name and the binding sit at a path's end, and
// the start is the part every project shares (`src/lib/...`), so it is what gives way.

import { assert } from '../../../shared/core/assert';

/** Characters of `file › expression` shown before the start is cut. */
export const SOURCE_CUE_CHARS_MAX = 56;

/** `text` itself when it fits, else an ellipsis and its last characters, `max` in all. */
export function truncateStart(text: string, max: number): string {
  assert(Number.isSafeInteger(max), 'truncateStart: max is a safe integer');
  assert(max >= 2, 'truncateStart: room for an ellipsis and a character');
  if (text.length <= max) {
    return text;
  }
  const out = `…${text.slice(text.length - (max - 1))}`;
  assert(out.length === max, 'truncateStart: the cut text is exactly max long');
  return out;
}

/** The code the cue shows: `file › expression`, or the expression alone for the page's own data. */
export function sourceCuePath(file: string, expression: string): string {
  return truncateStart(file === '' ? expression : `${file} › ${expression}`, SOURCE_CUE_CHARS_MAX);
}

// A file's line breaks, kept while its text is edited as `\n` lines.
//
// Why: CodeMirror splits a document on `\r\n`, `\r` and `\n` and hands back `\n` only, so a Windows file opened in a
// code editor and saved would have every line ending rewritten, a diff of the whole file for one typed letter. The
// editor is given the text with `\n` breaks and this layout beside it; a save puts each untouched line's own break back.
//
// How: the edited text is compared with the text as it opened, line by line. The lines both share at the start and at
// the end are untouched, so each keeps the break it had. Lines in between are new or changed and take the file's most
// common break. So the text as it opened always restores to the exact original, and an edit changes only its lines.
import { assert } from './assert';

export const LINE_BREAKS = ['\n', '\r\n', '\r'] as const;
export type LineBreak = (typeof LINE_BREAKS)[number];

export interface LineBreakLayout {
  /** The break after each line but the last: `breaks.length` is the line count less one. */
  readonly breaks: readonly LineBreak[];
  /** The break a new or changed line takes: the most common one, `\n` when there is none. */
  readonly common: LineBreak;
}

export interface NormalizedText {
  /** The text with every break written `\n`. */
  readonly text: string;
  readonly layout: LineBreakLayout;
}

/** Splits `source` at every break, `\r\n` first, then a lone `\r` or `\n`. One pass, no regular expression state. */
export function normalizeLineBreaks(source: string): NormalizedText {
  const breaks: LineBreak[] = [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const unit = source.charCodeAt(index);
    if (unit === CARRIAGE_RETURN) {
      lines.push(source.slice(start, index));
      if (source.charCodeAt(index + 1) === LINE_FEED) {
        breaks.push('\r\n');
        index += 1;
      } else {
        breaks.push('\r');
      }
      start = index + 1;
    } else if (unit === LINE_FEED) {
      lines.push(source.slice(start, index));
      breaks.push('\n');
      start = index + 1;
    }
  }
  lines.push(source.slice(start));
  assert(lines.length === breaks.length + 1, 'normalizeLineBreaks: one more line than breaks');
  const normalized = { text: lines.join('\n'), layout: { breaks, common: commonBreak(breaks) } };
  assert(restoreLineBreaks(normalized, normalized.text) === source, 'normalizeLineBreaks: the layout restores the source');
  return normalized;
}

/** `edited` (with `\n` breaks) written with the breaks of `opened`: untouched lines keep theirs, the rest take the common one. */
export function restoreLineBreaks(opened: NormalizedText, edited: string): string {
  assert(!edited.includes('\r'), 'restoreLineBreaks: the edited text has only \\n breaks');
  const { breaks, common } = opened.layout;
  if (breaks.every((each) => each === '\n') && common === '\n') {
    return edited;
  }
  const before = opened.text.split('\n');
  const after = edited.split('\n');
  assert(before.length === breaks.length + 1, 'restoreLineBreaks: the layout belongs to the opened text');
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < shorter - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  const shift = before.length - after.length;
  const parts: string[] = [];
  for (let index = 0; index < after.length; index += 1) {
    parts.push(after[index] ?? '');
    if (index < after.length - 1) {
      parts.push(breakAfter(index, { prefix, suffixStart: after.length - suffix, shift, breaks, common }));
    }
  }
  return parts.join('');
}

// The break after line `index` of the edited text. Between two untouched lines it is the break the opened text had
// there; after the last untouched line at the start it is that line's own; before the first untouched line at the end
// it is the break that led into it. Anywhere else the line is new or changed and takes the common break.
function breakAfter(
  index: number,
  place: { readonly prefix: number; readonly suffixStart: number; readonly shift: number; readonly breaks: readonly LineBreak[]; readonly common: LineBreak },
): LineBreak {
  const { prefix, suffixStart, shift, breaks, common } = place;
  if (index < prefix) {
    return breaks[index] ?? common;
  }
  if (index >= suffixStart) {
    assert(index + shift >= 0, 'breakAfter: a line of the untouched end matched a line of the opened text');
    return breaks[index + shift] ?? common;
  }
  if (index + 1 === suffixStart) {
    return breaks[suffixStart - 1 + shift] ?? common;
  }
  return common;
}

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

function commonBreak(breaks: readonly LineBreak[]): LineBreak {
  let best: LineBreak = '\n';
  let bestCount = 0;
  for (const candidate of LINE_BREAKS) {
    const total = breaks.filter((each) => each === candidate).length;
    if (total > bestCount) {
      best = candidate;
      bestCount = total;
    }
  }
  assert(bestCount <= breaks.length, 'commonBreak: a count is within the breaks');
  return best;
}

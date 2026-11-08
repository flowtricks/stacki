// The one rule for turning a CSS comment into a label.
//
// Stacki reads a comment between declarations as the heading of the lines
// under it (the Variables panel's groups). Authors do not write headings for an
// editor, though; they write comments for people, and a long one is written as
// a docblock: an opening line, then lines that start with a star gutter, then
// the closing line. Shown whole, such a heading read as the gutter's star, the
// first sentence and the start of the second, with its backticks raw. So the
// label is the comment's first sentence (or its first line, when the line has
// no sentence end), with the gutter of every line taken off, and the comment as
// a whole, de-guttered, is its description. The title is a span of the source
// as written, backticks included, so renaming the heading rewrites exactly
// those words and leaves the rest of the docblock alone; labelParts splits it
// into text and inline code for a view that can draw code.
//
// Both the main process (which reads the comment) and the renderer (which draws
// the label) read this module, so the two cannot disagree on what the title is.
import { assert } from '../core/assert';

/** Bounds on how much of a comment becomes a label. */
export const COMMENT_LABEL_LIMITS = {
  /** A description longer than this is cut, with an ellipsis: it is a tooltip, not the file. */
  descriptionCharsMax: 4096,
  /** Lines looked at for a title and a description; a comment is a note, not a document. */
  linesMax: 1024,
} as const satisfies Record<string, number>;

/** A comment as a label. Offsets count UTF-16 code units into the comment's body. */
export interface CommentLabel {
  /** The first sentence or line, as written: backticks stay, gutters and the closing full stop go. */
  readonly title: string;
  /** Where `title` sits in the body, so `body.slice(titleStart, titleEnd) === title`. */
  readonly titleStart: number;
  readonly titleEnd: number;
  /** The whole comment without its gutters, when it says more than the title. */
  readonly description: string | undefined;
}

/** One run of a title: words, or what sat between backticks. */
export type LabelPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'code'; readonly text: string };

/**
 * The label a comment gives, from the comment's body: the text between `/*` and
 * the closing delimiter. A comment with no words has an empty title at the
 * body's end.
 */
export function commentLabel(body: string): CommentLabel {
  const lines = commentLines(body);
  assert(lines.length <= COMMENT_LABEL_LIMITS.linesMax, 'commentLabel: lines are bounded');
  const first = lines.find((line) => line.text !== '');
  if (first === undefined) {
    return { title: '', titleStart: body.length, titleEnd: body.length, description: undefined };
  }
  const titleLength = titleLengthOf(first.text);
  const title = first.text.slice(0, titleLength);
  const titleStart = first.start;
  const titleEnd = titleStart + titleLength;
  assert(body.slice(titleStart, titleEnd) === title, 'commentLabel: the title is a span of the body');
  assert(title.trim() === title, 'commentLabel: the title has no edge whitespace');
  return { title, titleStart, titleEnd, description: descriptionOf(lines, title) };
}

/**
 * A title as runs of text and inline code. A backtick with no partner is text,
 * as it is in Markdown, and an empty pair (two backticks) is dropped.
 */
export function labelParts(title: string): readonly LabelPart[] {
  const pieces = title.split('`');
  assert(pieces.length <= title.length + 1, 'labelParts: one piece per backtick, plus one');
  const parts: LabelPart[] = [];
  // An odd count of backticks leaves the last one unpaired: it and what follows are text.
  const pairedCount = pieces.length % 2 === 1 ? pieces.length : pieces.length - 1;
  for (let index = 0; index < pairedCount; index++) {
    const text = pieces[index] ?? '';
    if (text !== '') {
      parts.push(index % 2 === 0 ? { kind: 'text', text } : { kind: 'code', text });
    }
  }
  if (pairedCount < pieces.length) {
    parts.push({ kind: 'text', text: `\`${pieces.slice(pairedCount).join('`')}` });
  }
  assert(
    parts.every((part) => part.text !== ''),
    'labelParts: no part is empty',
  );
  return mergeText(parts);
}

/** A title with its backticks taken off, for a place that holds only plain text. */
export function labelPlainText(title: string): string {
  return labelParts(title)
    .map((part) => part.text)
    .join('');
}

// One line of a comment with its gutter and edge whitespace taken off, and where
// what is left starts in the body.
interface CommentLine {
  readonly text: string;
  readonly start: number;
}

// A docblock's gutter: the whitespace and `*`s a line opens with, when the
// stars stand apart from the words (`* Brand`, a lone `*`). Stars touching a
// word (`*emphasis*`) are the author's text, not a gutter.
const GUTTER = /^\s*(?:\*+(?=\s|$))?\s*/;

function commentLines(body: string): readonly CommentLine[] {
  const lines: CommentLine[] = [];
  let start = 0;
  // Bounded twice: by the body's length (each pass moves past a newline) and by linesMax.
  while (start <= body.length) {
    if (lines.length < COMMENT_LABEL_LIMITS.linesMax) {
      const newline = body.indexOf('\n', start);
      const end = newline === -1 ? body.length : newline;
      const raw = body.slice(start, end);
      const gutterLength = GUTTER.exec(raw)?.[0].length ?? 0;
      lines.push({ text: raw.slice(gutterLength).trimEnd(), start: start + gutterLength });
      start = end + 1;
    } else {
      break;
    }
  }
  assert(lines.length > 0, 'commentLines: a body has at least one line');
  return lines;
}

// The length of a line's first sentence: up to a `.`, `!` or `?` that ends a
// word, outside inline code, or the whole line when it has no sentence end. A
// closing full stop is left off (a heading has none) unless it is part of an
// ellipsis, or all there is.
function titleLengthOf(line: string): number {
  assert(line.trim() === line, 'titleLengthOf: the line is trimmed');
  assert(line !== '', 'titleLengthOf: the line has words');
  const sentence = line.slice(0, sentenceEnd(line));
  if (sentence.endsWith('.')) {
    if (sentence.endsWith('..')) {
      return sentence.length;
    }
    const bare = sentence.slice(0, -1).trimEnd();
    return bare === '' ? sentence.length : bare.length;
  }
  return sentence.length;
}

// Where the first sentence of a line ends, its closing mark included.
function sentenceEnd(line: string): number {
  let inCode = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '`') {
      inCode = !inCode;
    } else if (inCode) {
      continue;
    } else if (character === '.' || character === '!' || character === '?') {
      const next = line[index + 1];
      if (next === undefined || /\s/.test(next)) {
        return index + 1;
      }
    }
  }
  return line.length;
}

// The comment's lines joined back up, blank lines at either end dropped, cut at
// the bound; absent when that is the title and nothing more.
function descriptionOf(lines: readonly CommentLine[], title: string): string | undefined {
  const whole = lines
    .map((line) => line.text)
    .join('\n')
    .trim();
  assert(whole.startsWith(title), 'descriptionOf: the description starts with the title');
  if (whole === title || whole === `${title}.`) {
    return undefined;
  }
  if (whole.length <= COMMENT_LABEL_LIMITS.descriptionCharsMax) {
    return whole;
  }
  return `${whole.slice(0, COMMENT_LABEL_LIMITS.descriptionCharsMax - 1)}…`;
}

// Neighbouring text runs as one: an unpaired backtick splits a run in two.
function mergeText(parts: readonly LabelPart[]): readonly LabelPart[] {
  const merged: LabelPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === 'text' && part.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + part.text };
    } else {
      merged.push(part);
    }
  }
  assert(merged.length <= parts.length, 'mergeText: merging never adds a part');
  return merged;
}

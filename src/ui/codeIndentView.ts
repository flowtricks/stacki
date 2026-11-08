// What a code editor shows for a piece of source, and how an edit goes back.
//
// Every Stacki editor indents with tabs, but the user's files are the user's: a
// file indented with spaces must stay that way, and opening it must write
// nothing. So the editor holds a view of the source, not the source, and the
// view keeps both sides of every line:
//
//   - Indentation shows as tabs, one per level of the source's own unit.
//   - A block (the inside of a <style> or <script>) also loses the indent it
//     shares and the blank lines that exist only because the tag's content
//     starts on a new line, so its least-indented line sits at column 0.
//   - On an edit, a line the user did not change keeps its original bytes. A
//     changed line keeps its original indent when its shown indent is the same,
//     so typing in a misaligned line does not realign it. Any other line is
//     written in the source's own indentation: spaces where the source clearly
//     uses spaces, otherwise tabs.
//
// The comparison is always against the text the view opened with, so undoing an
// edit gives back the original bytes, including any odd indentation.
//
// A line that starts inside a string or a template literal is left alone in both
// directions, because its leading whitespace is the string's content. A line
// inside a comment is indented as usual, since whitespace means nothing there,
// but it never decides the block's indent: a comment at column 0 must not stop
// the code around it from moving left.

import { assert } from '../../shared/core/assert';
import { CODE_INDENT_UNIT, leadingIndent, measuredIndent } from '../../shared/core/indent';
import { LIMITS } from '../../shared/core/limits';

/** A block is the inside of a tag and is dedented; a document is shown from column 0. */
export type CodeExtent = 'block' | 'document';

/** Which lines of a text start inside something indentation must respect. */
export interface CodeLineRoles {
  /** Lines starting inside a string or template literal: whitespace is content. */
  readonly verbatim: ReadonlySet<number>;
  /** Lines starting inside a comment: indentation is free, but says nothing. */
  readonly comment: ReadonlySet<number>;
}

export type CodeLineClassifier = (text: string) => CodeLineRoles;

export interface CodeViewOptions {
  readonly extent: CodeExtent;
  readonly classify: CodeLineClassifier;
}

/** A view of source text; open with openCodeView, advance with editCodeView. */
export interface CodeView {
  /** The bytes this view stands for. */
  readonly source: string;
  /** What the editor shows. */
  readonly text: string;
  /** Source lines above the first shown line. */
  readonly headLineCount: number;
  readonly opened: CodeViewOpened | undefined;
  readonly sourceLines: readonly string[];
  readonly shownLines: readonly string[];
}

/** What an edit is compared against; undefined on a view that shows its source as is. */
interface CodeViewOpened {
  readonly source: string;
  readonly text: string;
  readonly head: string;
  readonly tail: string;
  readonly layout: IndentLayout;
  readonly classify: CodeLineClassifier;
  readonly sourceLines: readonly string[];
  readonly shownLines: readonly string[];
}

interface IndentLayout {
  readonly base: string;
  readonly baseWidth: number;
  readonly unit: string;
  readonly unitWidth: number;
  readonly lineEnd: '' | '\r';
  /** The block's first line sits on the tag's own line, so it takes no base. */
  readonly firstLineFlush: boolean;
}

interface BlockFrame {
  readonly head: string;
  readonly body: string;
  readonly tail: string;
}

/** A changed line and the line it most likely was. */
export interface LinePair {
  readonly source: string;
  readonly shown: string;
}

/** The two sides of a text as it opened, and the lines it has now. */
export interface LineEdit {
  readonly source: readonly string[];
  readonly shown: readonly string[];
  readonly next: readonly string[];
}

// A line diff fills a table of this many cells at most. Past it the changed
// region counts as changed throughout, which costs nothing in bytes: each line
// is still paired with the one it replaced and keeps its indent.
const LINE_DIFF_CELLS_MAX = 1_000_000;

/** The view of `source`. Nothing is written by opening one. */
export function openCodeView(source: string, options: CodeViewOptions): CodeView {
  if (showsAsIs(source, options.extent)) {
    return sourceCodeView(source);
  }
  const frame = options.extent === 'block' ? blockFrame(source) : { head: '', body: source, tail: '' };
  const sourceLines = frame.body.split('\n');
  const bareLines = sourceLines.map(withoutCarriageReturn);
  const roles = options.classify(bareLines.join('\n'));
  const layout = indentLayoutOf(source, frame, { lines: bareLines, roles, extent: options.extent });
  const shownLines = bareLines.map((line, index) => shownLine(line, index, { layout, roles }));
  assert(shownLines.length === sourceLines.length, 'openCodeView: one shown line per source line');
  const text = shownLines.join('\n');
  const opened = { source, text, head: frame.head, tail: frame.tail, layout, classify: options.classify, sourceLines, shownLines };
  return { source, text, headLineCount: lineBreakCount(frame.head), opened, sourceLines, shownLines };
}

/** The view after the editor's text became `text`. */
export function editCodeView(view: CodeView, text: string): CodeView {
  const { opened } = view;
  if (opened === undefined) {
    return sourceCodeView(text);
  }
  const nextLines = text.split('\n');
  if (text === opened.text) {
    return { ...view, source: opened.source, text, sourceLines: opened.sourceLines, shownLines: opened.shownLines };
  }
  const roles = opened.classify(text);
  const sourceLines = keepUntouchedLines({ source: opened.sourceLines, shown: opened.shownLines, next: nextLines }, (line, index, pair) =>
    writtenLine(line, index, { layout: opened.layout, roles, pair }),
  );
  assert(sourceLines.length === nextLines.length, 'editCodeView: one source line per shown line');
  const source = text.length === 0 ? opened.tail : `${opened.head}${sourceLines.join('\n')}${opened.tail}`;
  return { ...view, source, text, sourceLines, shownLines: nextLines };
}

/** Where a source offset sits in the shown text. */
export function codeViewOffset(view: CodeView, sourceOffset: number): number {
  assert(Number.isSafeInteger(sourceOffset), 'codeViewOffset: an offset is a safe integer');
  if (view.opened === undefined) {
    return Math.min(Math.max(sourceOffset, 0), view.text.length);
  }
  const offset = mappedOffset(sourceOffset - view.opened.head.length, view.sourceLines, view.shownLines);
  assert(offset >= 0, 'codeViewOffset: a mapped offset is never negative');
  return Math.min(offset, view.text.length);
}

/** Where a shown offset sits in the source. */
export function codeSourceOffset(view: CodeView, shownOffset: number): number {
  assert(Number.isSafeInteger(shownOffset), 'codeSourceOffset: an offset is a safe integer');
  if (view.opened === undefined) {
    return Math.min(Math.max(shownOffset, 0), view.source.length);
  }
  const offset = view.opened.head.length + mappedOffset(shownOffset, view.shownLines, view.sourceLines);
  assert(offset >= 0, 'codeSourceOffset: a mapped offset is never negative');
  return Math.min(offset, view.source.length);
}

/**
 * The source lines for an edit: each next line equal to a shown line takes that
 * line's source bytes, and `write` gives the rest, with the line each one
 * replaced when there is one. Unchanged lines are found by a real line diff, so
 * two edits far apart leave everything between them alone.
 */
export function keepUntouchedLines(edit: LineEdit, write: (line: string, index: number, pair: LinePair | undefined) => string): readonly string[] {
  assert(edit.source.length === edit.shown.length, 'keepUntouchedLines: one source line per shown line');
  const matches = matchedLines(edit.shown, edit.next);
  assert(matches.length === edit.next.length, 'keepUntouchedLines: one match entry per next line');
  const upcoming = upcomingMatches(matches, edit.shown.length);
  const written: string[] = [];
  let cursor = 0;
  for (const [index, line] of edit.next.entries()) {
    const match = matches[index];
    if (match === undefined) {
      const limit = upcoming[index] ?? edit.shown.length;
      const source = cursor < limit ? edit.source[cursor] : undefined;
      const shown = cursor < limit ? edit.shown[cursor] : undefined;
      cursor += 1;
      written.push(write(line, index, source === undefined || shown === undefined ? undefined : { source, shown }));
    } else {
      const source = edit.source[match];
      assert(source !== undefined, 'keepUntouchedLines: a matched line exists');
      cursor = match + 1;
      written.push(source);
    }
  }
  return written;
}

// A document with no space indentation and no carriage return already shows as
// it should, which is every file Stacki wrote, so it costs no parse per keystroke.
// Past the highlight bound a parse per keystroke is not affordable at all.
function showsAsIs(source: string, extent: CodeExtent): boolean {
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    return true;
  }
  if (extent === 'block') {
    return false;
  }
  return !/^ /m.test(source) && !source.includes('\r');
}

/** A view that shows its source byte for byte. */
export function sourceCodeView(text: string): CodeView {
  return { source: text, text, headLineCount: 0, opened: undefined, sourceLines: [], shownLines: [] };
}

// Splits a block into the lines shown and the whitespace around them. Content on
// the tag's own line has no newline before it, so only the space before it is
// the head. A block of nothing but whitespace shows empty and would hold its
// first typed line between the same line breaks the closing tag sits behind.
function blockFrame(source: string): BlockFrame {
  const contentStart = source.search(/\S/);
  if (contentStart < 0) {
    const firstBreak = source.indexOf('\n');
    if (firstBreak < 0) {
      return { head: source, body: '', tail: '' };
    }
    return { head: source.slice(0, firstBreak + 1), body: '', tail: source.slice(source.lastIndexOf('\n')) };
  }
  const lineStart = source.lastIndexOf('\n', contentStart) + 1;
  const head = source.slice(0, lineStart > 0 ? lineStart : contentStart);
  const contentEnd = source.trimEnd().length;
  const nextBreak = source.indexOf('\n', contentEnd);
  let tailStart = contentEnd;
  if (nextBreak >= 0) {
    tailStart = source[nextBreak - 1] === '\r' ? nextBreak - 1 : nextBreak;
  }
  const frame = { head, body: source.slice(head.length, tailStart), tail: source.slice(tailStart) };
  assert(frame.head + frame.body + frame.tail === source, 'blockFrame: the frame is the whole block');
  assert(frame.body.length > 0, 'blockFrame: a block with content has a body');
  return frame;
}

function indentLayoutOf(
  source: string,
  frame: BlockFrame,
  text: { readonly lines: readonly string[]; readonly roles: CodeLineRoles; readonly extent: CodeExtent },
): IndentLayout {
  const firstLineFlush = text.extent === 'block' && !frame.head.includes('\n');
  const indented = text.lines.filter((line, index) => isOwnLine(line, index, { roles: text.roles, firstLineFlush }));
  const closingIndent = frame.body.length === 0 ? leadingIndent(frame.tail.slice(frame.tail.lastIndexOf('\n') + 1)) : '';
  const measured = measuredIndent(indented.length > 0 ? indented : [closingIndent]);
  const lineEnd = source.includes('\r\n') ? '\r' : '';
  const shared = { unit: measured.unit, unitWidth: measured.unitWidth, lineEnd, firstLineFlush } as const;
  if (text.extent === 'document') {
    return { ...shared, base: '', baseWidth: 0 };
  }
  if (indented.length === 0) {
    return { ...shared, base: closingIndent, baseWidth: indentWidth(closingIndent, measured.unitWidth) };
  }
  let base = leadingIndent(indented[0] ?? '');
  let baseWidth = indentWidth(base, measured.unitWidth);
  for (const line of indented) {
    const indent = leadingIndent(line);
    const width = indentWidth(indent, measured.unitWidth);
    if (width < baseWidth) {
      base = indent;
      baseWidth = width;
    }
  }
  return { ...shared, base, baseWidth };
}

// A line of code that starts its own line: the ones the block's indent is read
// from. A blank line and one inside a string or comment say nothing about it.
function isOwnLine(line: string, index: number, context: { readonly roles: CodeLineRoles; readonly firstLineFlush: boolean }): boolean {
  if (line.trim().length === 0) {
    return false;
  }
  if (context.roles.verbatim.has(index)) {
    return false;
  }
  if (context.roles.comment.has(index)) {
    return false;
  }
  return index > 0 || !context.firstLineFlush;
}

function indentWidth(indent: string, tabWidth: number): number {
  let width = 0;
  for (const character of indent) {
    width += character === '\t' ? tabWidth : 1;
  }
  return width;
}

function shownLine(line: string, index: number, context: { readonly layout: IndentLayout; readonly roles: CodeLineRoles }): string {
  if (context.roles.verbatim.has(index)) {
    return line;
  }
  const indent = leadingIndent(line);
  const content = line.slice(indent.length);
  if (content.length === 0) {
    return '';
  }
  const { layout } = context;
  const relative = Math.max(0, indentWidth(indent, layout.unitWidth) - layout.baseWidth);
  const levels = Math.floor(relative / layout.unitWidth);
  return CODE_INDENT_UNIT.repeat(levels) + ' '.repeat(relative - levels * layout.unitWidth) + content;
}

function writtenLine(
  line: string,
  index: number,
  context: { readonly layout: IndentLayout; readonly roles: CodeLineRoles; readonly pair: LinePair | undefined },
): string {
  const { layout, pair } = context;
  if (context.roles.verbatim.has(index)) {
    return line + layout.lineEnd;
  }
  const indent = leadingIndent(line);
  const content = line.slice(indent.length);
  if (content.length === 0) {
    return layout.lineEnd;
  }
  // A blank line has no indent of its own to keep: what is typed there is new.
  if (pair !== undefined && pair.shown.length > 0 && leadingIndent(pair.shown) === indent) {
    return leadingIndent(pair.source) + content + layout.lineEnd;
  }
  const width = indentWidth(indent, layout.unitWidth);
  const levels = Math.floor(width / layout.unitWidth);
  const base = index === 0 && layout.firstLineFlush ? '' : layout.base;
  return base + layout.unit.repeat(levels) + ' '.repeat(width - levels * layout.unitWidth) + content + layout.lineEnd;
}

// For each next line, the shown line it equals, or undefined when it changed.
function matchedLines(before: readonly string[], after: readonly string[]): readonly (number | undefined)[] {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < shorter - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  const matches: (number | undefined)[] = after.map(() => undefined);
  for (let index = 0; index < prefix; index += 1) {
    matches[index] = index;
  }
  for (let offset = 1; offset <= suffix; offset += 1) {
    matches[after.length - offset] = before.length - offset;
  }
  const rows = before.length - prefix - suffix;
  const columns = after.length - prefix - suffix;
  if (rows > 0 && columns > 0 && rows * columns <= LINE_DIFF_CELLS_MAX) {
    for (const [afterIndex, beforeIndex] of matchedMiddleLines({ before, after, prefix, rows, columns })) {
      matches[afterIndex] = beforeIndex;
    }
  }
  return matches;
}

// The longest common subsequence of the changed region, as pairs of the next
// line's index and the shown line's index.
function matchedMiddleLines(region: {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly prefix: number;
  readonly rows: number;
  readonly columns: number;
}): readonly (readonly [number, number])[] {
  const { before, after, prefix, rows, columns } = region;
  const stride = columns + 1;
  const table = new Uint32Array((rows + 1) * stride);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const equal = before[prefix + row] === after[prefix + column];
      const diagonal = (table[(row + 1) * stride + column + 1] ?? 0) + 1;
      const best = Math.max(table[(row + 1) * stride + column] ?? 0, table[row * stride + column + 1] ?? 0);
      table[row * stride + column] = equal ? diagonal : best;
    }
  }
  const pairs: (readonly [number, number])[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[prefix + row] === after[prefix + column]) {
      pairs.push([prefix + column, prefix + row]);
      row += 1;
      column += 1;
    } else if ((table[(row + 1) * stride + column] ?? 0) >= (table[row * stride + column + 1] ?? 0)) {
      row += 1;
    } else {
      column += 1;
    }
  }
  assert(pairs.length <= Math.min(rows, columns), 'matchedMiddleLines: each line pairs at most once');
  return pairs;
}

// For each next line, the next shown line matched at or after it: the bound of
// the shown lines a changed line may pair with.
function upcomingMatches(matches: readonly (number | undefined)[], shownCount: number): readonly number[] {
  const upcoming: number[] = matches.map(() => shownCount);
  let next = shownCount;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    next = matches[index] ?? next;
    upcoming[index] = next;
  }
  return upcoming;
}

function mappedOffset(offset: number, fromLines: readonly string[], toLines: readonly string[]): number {
  assert(fromLines.length === toLines.length, 'mappedOffset: the two sides have the same lines');
  let fromStart = 0;
  let toStart = 0;
  for (const [index, from] of fromLines.entries()) {
    const to = toLines[index] ?? '';
    if (offset <= fromStart + from.length) {
      return toStart + mappedColumn(Math.max(offset - fromStart, 0), from, to);
    }
    fromStart += from.length + 1;
    toStart += to.length + 1;
  }
  return Math.max(toStart - 1, 0);
}

function mappedColumn(column: number, from: string, to: string): number {
  const fromIndent = leadingIndent(from).length;
  const toIndent = leadingIndent(to).length;
  if (column < fromIndent) {
    return Math.min(column, toIndent);
  }
  return Math.min(column - fromIndent + toIndent, to.length);
}

function lineBreakCount(text: string): number {
  return text.split('\n').length - 1;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

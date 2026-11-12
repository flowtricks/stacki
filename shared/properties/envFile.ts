// The project's `.env` file as an ordered list of lines that prints back byte for byte.
// A person's file holds comments, blank lines, `export` prefixes, quoting, spacing, a
// byte-order mark and CRLF endings that no edit of one secret may disturb, so parsing
// keeps every piece of text it does not change: `serializeEnvFile(parseEnvFile(text))`
// is `text`, and an edit rewrites only the line it touches. Lines it cannot understand
// are kept verbatim and counted, never dropped.
//
// Values follow what Vite's dotenv reads. Unquoted values end at whitespace followed by
// `#`; single-quoted and backtick-quoted values are literal; double-quoted values expand
// `\n` and `\r` only (dotenv does no other escaping). A quoted value may span lines; it
// is listed but never edited here, because the one-line field cannot show its breaks.
// Everything is bounded by ENV_LIMITS: a file past a bound is refused whole, with its
// bytes untouched.
//
// Nothing here reads or writes a file, and no error value carries a name or a value.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';

export const ENV_LIMITS = {
  /** A variable name, in characters. */
  nameCharsMax: 128,
  /** A value, in UTF-8 bytes. */
  valueBytesMax: 16 * 1024,
  /** Variables in one file. */
  entriesMax: 512,
  /** Lines in one file, comments and blanks included. */
  linesMax: 4000,
  /** The whole file, in UTF-8 bytes. */
  fileBytesMax: 256 * 1024,
} as const satisfies Record<string, number>;

export type EnvQuote = 'none' | 'single' | 'double' | 'backtick';

export type EnvParseError = 'too-large' | 'too-many-lines' | 'too-many-entries';

export type EnvEditError = 'invalid-name' | 'invalid-value' | 'name-taken' | 'not-found' | 'read-only' | 'limit';

interface EnvTextItem {
  readonly kind: 'text';
  readonly role: 'blank' | 'comment' | 'invalid';
  readonly text: string;
  readonly lineEnding: string;
}

interface EnvEntryItem {
  readonly kind: 'entry';
  readonly indent: string;
  /** `export ` as written, with its spacing; empty when the line has none. */
  readonly exportPrefix: string;
  readonly name: string;
  readonly gapBeforeEquals: string;
  readonly gapAfterEquals: string;
  readonly quote: EnvQuote;
  /** The value exactly as written, quotes included. */
  readonly valueText: string;
  /** The value as dotenv reads it. */
  readonly value: string;
  /** Whatever follows the value: spacing and an inline comment. */
  readonly tail: string;
  readonly lineEnding: string;
}

type EnvItem = EnvTextItem | EnvEntryItem;

export interface EnvFile {
  readonly hasByteOrderMark: boolean;
  readonly items: readonly EnvItem[];
}

/** One variable as the panel lists it. `index` counts variables only, from 0, in file order. */
export interface EnvEntryView {
  readonly index: number;
  readonly name: string;
  readonly value: string;
  readonly quote: EnvQuote;
  readonly multiline: boolean;
  /** The name is set again elsewhere in the file; the last one wins when the file is read. */
  readonly duplicate: boolean;
}

export type EnvChange =
  | { readonly kind: 'add'; readonly name: string; readonly value: string }
  /** `value` absent keeps the value text as it is written. */
  | { readonly kind: 'update'; readonly index: number; readonly name: string; readonly value: string | undefined }
  | { readonly kind: 'remove'; readonly index: number };

const BYTE_ORDER_MARK = '﻿';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENTRY_HEAD = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)([ \t]*)=([ \t]*)/;
const TAIL_PATTERN = /^[ \t]*(#.*)?$/;
const COMMENT_START = /(^|[ \t])#/;
// Characters an unquoted value may hold without a quote changing what dotenv reads.
const UNQUOTED_SAFE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/** Whether `name` is a variable name this panel writes. */
export function isEnvName(name: string): boolean {
  return name.length > 0 && name.length <= ENV_LIMITS.nameCharsMax && NAME_PATTERN.test(name);
}

/** Why `value` cannot be written on one line, or undefined when it can. */
export function envValueProblem(value: string): 'too-long' | 'line-break' | 'null-character' | undefined {
  if (value.includes('\0')) {
    return 'null-character';
  }
  if (/[\r\n]/.test(value)) {
    return 'line-break';
  }
  if (new TextEncoder().encode(value).length > ENV_LIMITS.valueBytesMax) {
    return 'too-long';
  }
  return undefined;
}

/** Reads a file's text. Only a bound can refuse it; any content is kept. */
export function parseEnvFile(source: string): Result<EnvFile, EnvParseError> {
  if (source.length > ENV_LIMITS.fileBytesMax) {
    return err('too-large');
  }
  const hasByteOrderMark = source.startsWith(BYTE_ORDER_MARK);
  const body = hasByteOrderMark ? source.slice(BYTE_ORDER_MARK.length) : source;
  const lines = splitLines(body);
  if (lines === undefined) {
    return err('too-many-lines');
  }
  const items: EnvItem[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    assert(line !== undefined, 'A line index inside the list reads a line');
    const taken = readItem(lines, at);
    items.push(taken.item);
    assert(taken.next > at, 'Reading an item consumes at least one line');
    at = taken.next;
    assert(items.length <= ENV_LIMITS.linesMax, 'Items never outnumber lines');
  }
  const file: EnvFile = { hasByteOrderMark, items };
  if (entryCount(file) > ENV_LIMITS.entriesMax) {
    return err('too-many-entries');
  }
  return ok(file);
}

/** The file's text. For a parsed file that no edit touched this is the text it was read from. */
export function serializeEnvFile(file: EnvFile): string {
  const parts: string[] = file.hasByteOrderMark ? [BYTE_ORDER_MARK] : [];
  for (const item of file.items) {
    parts.push(item.kind === 'text' ? item.text : printEntry(item), item.lineEnding);
  }
  return parts.join('');
}

/** The variables in file order. */
export function envEntries(file: EnvFile): readonly EnvEntryView[] {
  const counts = new Map<string, number>();
  for (const item of file.items) {
    if (item.kind === 'entry') {
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    }
  }
  const views: EnvEntryView[] = [];
  for (const item of file.items) {
    if (item.kind === 'entry') {
      views.push({
        index: views.length,
        name: item.name,
        value: item.value,
        quote: item.quote,
        multiline: /[\r\n]/.test(item.valueText),
        duplicate: (counts.get(item.name) ?? 0) > 1,
      });
    }
  }
  assert(views.length === entryCount(file), 'Every variable is listed once');
  return views;
}

/** Lines that are neither blank, a comment nor a variable: kept as written. */
export function envInvalidLines(file: EnvFile): number {
  return file.items.filter((item) => item.kind === 'text' && item.role === 'invalid').length;
}

/** The file with `change` applied. Only the touched line differs from the original text. */
export function changeEnvFile(file: EnvFile, change: EnvChange): Result<EnvFile, EnvEditError> {
  assert(entryCount(file) <= ENV_LIMITS.entriesMax, 'A file held to its bounds is edited');
  switch (change.kind) {
    case 'add':
      return addEntry(file, change.name, change.value);
    case 'update':
      return updateEntry(file, change.index, change.name, change.value);
    case 'remove':
      return removeEntry(file, change.index);
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function addEntry(file: EnvFile, name: string, value: string): Result<EnvFile, EnvEditError> {
  if (!isEnvName(name)) {
    return err('invalid-name');
  }
  if (envValueProblem(value) !== undefined) {
    return err('invalid-value');
  }
  if (entryCount(file) >= ENV_LIMITS.entriesMax) {
    return err('limit');
  }
  if (file.items.some((item) => item.kind === 'entry' && item.name === name)) {
    return err('name-taken');
  }
  const written = writtenValue(value, 'none');
  if (written === undefined) {
    return err('invalid-value');
  }
  const ending = dominantLineEnding(file);
  const last = file.items[file.items.length - 1];
  // A file that ended without a newline still does: the new last line carries that, the old one gets a break.
  const closesWithBreak = last === undefined || last.lineEnding !== '';
  const kept = closesWithBreak ? file.items : [...file.items.slice(0, -1), { ...last, lineEnding: ending }];
  const added: EnvEntryItem = {
    kind: 'entry',
    indent: '',
    exportPrefix: '',
    name,
    gapBeforeEquals: '',
    gapAfterEquals: '',
    quote: written.quote,
    valueText: written.text,
    value,
    tail: '',
    lineEnding: closesWithBreak ? ending : '',
  };
  const next: EnvFile = { ...file, items: [...kept, added] };
  assert(entryCount(next) === entryCount(file) + 1, 'An added variable is one more');
  return ok(next);
}

function updateEntry(file: EnvFile, index: number, name: string, value: string | undefined): Result<EnvFile, EnvEditError> {
  const position = itemPosition(file, index);
  if (position === undefined) {
    return err('not-found');
  }
  const current = file.items[position];
  assert(current?.kind === 'entry', 'A variable position holds a variable');
  if (!isEnvName(name)) {
    return err('invalid-name');
  }
  if (file.items.some((item, at) => item.kind === 'entry' && at !== position && item.name === name)) {
    return err('name-taken');
  }
  let replaced: EnvEntryItem = { ...current, name };
  if (value !== undefined) {
    if (/[\r\n]/.test(current.valueText)) {
      return err('read-only');
    }
    if (envValueProblem(value) !== undefined) {
      return err('invalid-value');
    }
    const written = writtenValue(value, current.quote);
    if (written === undefined) {
      return err('invalid-value');
    }
    replaced = { ...replaced, quote: written.quote, valueText: written.text, value };
  }
  const next: EnvFile = { ...file, items: file.items.map((item, at) => (at === position ? replaced : item)) };
  assert(next.items.length === file.items.length, 'An update keeps every line');
  return ok(next);
}

function removeEntry(file: EnvFile, index: number): Result<EnvFile, EnvEditError> {
  const position = itemPosition(file, index);
  if (position === undefined) {
    return err('not-found');
  }
  const next: EnvFile = { ...file, items: file.items.filter((_item, at) => at !== position) };
  assert(entryCount(next) === entryCount(file) - 1, 'A removed variable is one fewer');
  return ok(next);
}

// The position in `items` of the `index`th variable.
function itemPosition(file: EnvFile, index: number): number | undefined {
  if (!Number.isSafeInteger(index) || index < 0) {
    return undefined;
  }
  let seen = 0;
  for (let at = 0; at < file.items.length; at += 1) {
    if (file.items[at]?.kind === 'entry') {
      if (seen === index) {
        return at;
      }
      seen += 1;
    }
  }
  return undefined;
}

function entryCount(file: EnvFile): number {
  return file.items.filter((item) => item.kind === 'entry').length;
}

function dominantLineEnding(file: EnvFile): string {
  const first = file.items.find((item) => item.lineEnding !== '');
  return first?.lineEnding ?? '\n';
}

function printEntry(item: EnvEntryItem): string {
  return `${item.indent}${item.exportPrefix}${item.name}${item.gapBeforeEquals}=${item.gapAfterEquals}${item.valueText}${item.tail}`;
}

// The text that writes `value`, in `preferred` style when it can say the value exactly, else the
// first style that can. Undefined only for a value no style holds.
function writtenValue(value: string, preferred: EnvQuote): { readonly quote: EnvQuote; readonly text: string } | undefined {
  assert(!/[\r\n]/.test(value), 'A written value is one line');
  const order: readonly EnvQuote[] = [preferred, 'none', 'single', 'backtick', 'double'];
  for (const quote of order) {
    if (quoteHolds(quote, value)) {
      return { quote, text: quoted(quote, value) };
    }
  }
  return undefined;
}

function quoteHolds(quote: EnvQuote, value: string): boolean {
  switch (quote) {
    case 'none':
      return UNQUOTED_SAFE.test(value);
    case 'single':
      return !value.includes("'");
    case 'backtick':
      return !value.includes('`');
    case 'double':
      // The reader (dotenv) has no escape for a double quote, and expands a written `\n` or `\r`.
      return !value.includes('"') && !/\\[nr]/.test(value);
    default: {
      const exhaustive: never = quote;
      return exhaustive;
    }
  }
}

function quoted(quote: EnvQuote, value: string): string {
  switch (quote) {
    case 'none':
      return value;
    case 'single':
      return `'${value}'`;
    case 'backtick':
      return `\`${value}\``;
    case 'double':
      return `"${value}"`;
    default: {
      const exhaustive: never = quote;
      return exhaustive;
    }
  }
}

interface SourceLine {
  readonly text: string;
  readonly lineEnding: string;
}

// Lines with their endings (`\r\n`, `\n` or a lone `\r`), or undefined past the line bound.
function splitLines(body: string): readonly SourceLine[] | undefined {
  const lines: SourceLine[] = [];
  const ending = /\r\n|\n|\r/g;
  let start = 0;
  for (let found = ending.exec(body); found !== null; found = ending.exec(body)) {
    if (lines.length >= ENV_LIMITS.linesMax) {
      return undefined;
    }
    lines.push({ text: body.slice(start, found.index), lineEnding: found[0] });
    start = found.index + found[0].length;
  }
  if (start < body.length) {
    if (lines.length >= ENV_LIMITS.linesMax) {
      return undefined;
    }
    lines.push({ text: body.slice(start), lineEnding: '' });
  }
  return lines;
}

// The item that starts at line `at`, and the line after it.
function readItem(lines: readonly SourceLine[], at: number): { readonly item: EnvItem; readonly next: number } {
  const line = lines[at];
  assert(line !== undefined, 'An item starts on a line');
  if (line.text.trim() === '') {
    return { item: { kind: 'text', role: 'blank', text: line.text, lineEnding: line.lineEnding }, next: at + 1 };
  }
  if (line.text.trimStart().startsWith('#')) {
    return { item: { kind: 'text', role: 'comment', text: line.text, lineEnding: line.lineEnding }, next: at + 1 };
  }
  const single = readEntry(line.text, line.lineEnding);
  if (single === 'unterminated') {
    return readQuotedAcrossLines(lines, at);
  }
  if (single === undefined) {
    return { item: { kind: 'text', role: 'invalid', text: line.text, lineEnding: line.lineEnding }, next: at + 1 };
  }
  return { item: single, next: at + 1 };
}

// A quote opened and not closed on its line: the value runs to the first later line that closes it.
function readQuotedAcrossLines(lines: readonly SourceLine[], at: number): { readonly item: EnvItem; readonly next: number } {
  const first = lines[at];
  assert(first !== undefined, 'A multi-line value starts on a line');
  let text = first.text;
  for (let end = at + 1; end < lines.length; end += 1) {
    const line = lines[end];
    assert(line !== undefined, 'A continuation index inside the list reads a line');
    text = `${text}${lines[end - 1]?.lineEnding ?? ''}${line.text}`;
    const joined = readEntry(text, line.lineEnding);
    if (joined !== undefined && joined !== 'unterminated') {
      return { item: joined, next: end + 1 };
    }
  }
  // Never closed: the one line stays as written and the lines after it are read on their own.
  return { item: { kind: 'text', role: 'invalid', text: first.text, lineEnding: first.lineEnding }, next: at + 1 };
}

function readEntry(text: string, lineEnding: string): EnvEntryItem | 'unterminated' | undefined {
  const head = ENTRY_HEAD.exec(text);
  if (head === null) {
    return undefined;
  }
  const rest = text.slice(head[0].length);
  const opening = rest.charAt(0);
  const base = {
    kind: 'entry' as const,
    indent: head[1] ?? '',
    exportPrefix: head[2] ?? '',
    name: head[3] ?? '',
    gapBeforeEquals: head[4] ?? '',
    gapAfterEquals: head[5] ?? '',
    lineEnding,
  };
  assert(base.name.length > 0, 'A matched variable has a name');
  if (opening === '"' || opening === "'" || opening === '`') {
    const close = closingQuote(rest, opening);
    if (close === undefined) {
      return 'unterminated';
    }
    const tail = rest.slice(close + 1);
    if (!TAIL_PATTERN.test(tail)) {
      return undefined;
    }
    const inner = rest.slice(1, close);
    const quote: EnvQuote = opening === '"' ? 'double' : opening === "'" ? 'single' : 'backtick';
    return { ...base, quote, valueText: rest.slice(0, close + 1), value: quote === 'double' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner, tail };
  }
  const comment = COMMENT_START.exec(rest);
  const content = comment === null ? rest : rest.slice(0, comment.index);
  const valueText = content.replace(/[ \t]+$/, '');
  return { ...base, quote: 'none', valueText, value: valueText, tail: rest.slice(valueText.length) };
}

// The index of the quote that closes `rest`, which opens with `quote`; double quotes skip a backslash pair.
function closingQuote(rest: string, quote: string): number | undefined {
  for (let at = 1; at < rest.length; at += 1) {
    const character = rest.charAt(at);
    if (quote === '"' && character === '\\') {
      at += 1;
    } else if (character === quote) {
      return at;
    }
  }
  return undefined;
}

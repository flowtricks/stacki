// A minimal TOML section editor for Codex's `~/.codex/config.toml`, for the MCP tab: list the servers in
// the `[mcp_servers.<name>]` tables, add or replace one, remove one. Pure text in, text out; the main
// process reads and writes the file (and checks its digest).
//
// Why hand-written and not a TOML library: the file is a person's own, full of comments, other tools'
// tables and their spacing. A library that parses and prints would rewrite all of it. This editor finds
// the byte range of the tables it owns and splices only those; every other byte is returned as it came,
// including the byte-order mark, line endings (the file's own are used for new lines), comments and a
// missing final newline.
//
// How: one lexer reads the whole file (not only the MCP part) so that a `[header]` is recognised only
// at the start of a line, outside any string, array or inline table. A multi-line string that holds a
// line starting with `[` cannot be mistaken for a table. Anything the lexer does not understand
// anywhere in the file, and anything about `mcp_servers` it would have to guess at (an inline
// `mcp_servers = {…}`, dotted keys that define a server, a repeated table, an array of tables), is a
// refusal with the text untouched: the editor never writes into a file it doubts.
//
// Which keys: mcpCodex.ts says how a server's fields are spelled. Keys outside that set (`enabled`,
// `startup_timeout_sec`, `cwd`, comments) are left where they are. A problem carries a code and a line
// number, never file text, so no value can reach a log or a message through it.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import {
  CODEX_MANAGED_KEYS,
  CODEX_SERVERS_TABLE,
  CODEX_TABLE_KEYS,
  fromCodexFields,
  tomlKey,
  tomlString,
  toCodexFields,
  type CodexFields,
  type CodexManagedKey,
  type CodexTableKey,
} from './mcpCodex';
import { MCP_LIMITS, isMcpServerName, type McpPair, type McpServerConfig } from './mcpConfig';

export const CODEX_TOML_LIMITS = {
  /** The file, in UTF-8 bytes. */
  fileBytesMax: MCP_LIMITS.fileBytesMax,
  /** Lines in the file. */
  linesMax: 4000,
  /** Tables, including arrays of tables. */
  tablesMax: 2048,
  /** Key-value entries in the whole file. */
  entriesMax: 8192,
  /** Segments in a dotted key. */
  keySegmentsMax: 16,
  /** Arrays and inline tables inside one another. */
  depthMax: 8,
  /** Items in one array or inline table. */
  itemsMax: 1024,
} as const satisfies Record<string, number>;

export type CodexProblemCode = 'too-large' | 'too-many' | 'syntax' | 'unsupported' | 'duplicate-table' | 'not-found' | 'unmappable' | 'bad-name';

/** What went wrong and on which line (1-based, when there is one). It never holds file text. */
export interface CodexProblem {
  readonly code: CodexProblemCode;
  readonly line: number | undefined;
}

export type TomlValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean' | 'integer' | 'other' }
  | { readonly kind: 'array'; readonly items: readonly TomlValue[] }
  | { readonly kind: 'table'; readonly entries: readonly TomlInlineEntry[] };

export interface TomlInlineEntry {
  readonly key: string;
  readonly value: TomlValue;
}

/** One `key = value` statement, with the byte offsets an edit needs. */
export interface TomlEntry {
  readonly key: readonly string[];
  readonly value: TomlValue;
  /** Start of the line the statement begins on. */
  readonly lineStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** The end of the statement's last line, before its line break and including a trailing comment. */
  readonly lineEnd: number;
}

export interface TomlTable {
  readonly path: readonly string[];
  readonly array: boolean;
  readonly headerStart: number;
  readonly entries: readonly TomlEntry[];
  /** The end of the table's last statement (or its header), before the line break: where an addition goes. */
  readonly contentEnd: number;
}

/** The scan of a file: opaque to callers, handed back to the functions here. */
export interface CodexDocument {
  readonly text: string;
  readonly eol: '\n' | '\r\n';
  readonly tables: readonly TomlTable[];
  readonly rootEntries: readonly TomlEntry[];
}

export interface CodexServerEntry {
  readonly name: string;
  /** `undefined` when the tables exist but are not one server this panel can show. */
  readonly config: McpServerConfig | undefined;
}

export type CodexChange =
  { readonly kind: 'put'; readonly name: string; readonly config: McpServerConfig } | { readonly kind: 'remove'; readonly name: string };

// Scanning: the lexer and the checks that decide whether the file is safe to edit.

/** Reads the whole file, or says why it will not be touched. */
export function scanCodexToml(text: string): Result<CodexDocument, CodexProblem> {
  // Every character is at least one byte, so a longer text is too large without encoding it.
  if (text.length > CODEX_TOML_LIMITS.fileBytesMax || new TextEncoder().encode(text).length > CODEX_TOML_LIMITS.fileBytesMax) {
    return err({ code: 'too-large', line: undefined });
  }
  if (lineCount(text) > CODEX_TOML_LIMITS.linesMax) {
    return err({ code: 'too-many', line: undefined });
  }
  try {
    const lexed = lexDocument(text);
    const refusal = checkDocument(lexed);
    if (refusal !== undefined) {
      return err({ code: refusal.code, line: lineOf(text, refusal.offset) });
    }
    return ok(lexed);
  } catch (failure: unknown) {
    if (failure instanceof TomlFailure) {
      return err({ code: failure.code, line: lineOf(text, failure.offset) });
    }
    throw failure;
  }
}

/** The servers under `[mcp_servers]`, in file order. A name this panel cannot hold is left out. */
export function codexServerEntries(document: CodexDocument): readonly CodexServerEntry[] {
  const entries: CodexServerEntry[] = [];
  for (const group of serverGroups(document).values()) {
    if (isMcpServerName(group.name)) {
      const fields = readFields(group);
      entries.push({ name: group.name, config: fields === undefined ? undefined : fromCodexFields(fields) });
    }
  }
  assert(entries.length <= CODEX_TOML_LIMITS.tablesMax, 'A file lists no more servers than it has tables');
  return entries;
}

class TomlFailure extends Error {
  readonly code: CodexProblemCode;
  readonly offset: number;

  constructor(code: CodexProblemCode, offset: number) {
    super(code);
    this.name = 'TomlFailure';
    this.code = code;
    this.offset = offset;
  }
}

function lineCount(text: string): number {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    lines += 1;
    if (lines > CODEX_TOML_LIMITS.linesMax + 1) {
      break;
    }
  }
  return lines;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) {
    line += 1;
  }
  return line;
}

const BARE_KEY_CHARACTER = /[A-Za-z0-9_-]/;
const INTEGER_TOKEN = /^(?:[+-]?(?:0|[1-9](?:_?\d)*)|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)$/;
const FLOAT_TOKEN = /^(?:[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|[+-]?(?:inf|nan))$/;
const TIME_TOKEN = /^(?:\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const TOKEN_END = new Set([' ', '\t', '\r', '\n', ',', ']', '}', '#', '']);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

class Lexer {
  position: number;
  readonly text: string;

  constructor(text: string, start: number) {
    this.text = text;
    this.position = start;
  }

  peek(ahead: number): string {
    assert(ahead >= 0, 'The lexer looks forward only');
    assert(this.position >= 0, 'The lexer position is never negative');
    return this.text[this.position + ahead] ?? '';
  }

  fail(code: CodexProblemCode): never {
    assert(this.position >= 0, 'A failure names a real position');
    assert(code.length > 0, 'A failure has a code');
    throw new TomlFailure(code, this.position);
  }

  advance(count: number): void {
    assert(count > 0, 'The lexer only moves forward');
    assert(this.position + count <= this.text.length + 1, 'The lexer stays within the text');
    this.position += count;
  }

  skipSpaces(): void {
    assert(this.position <= this.text.length, 'Spaces are skipped inside the text');
    assert(this.position >= 0, 'Spaces are skipped from a real position');
    for (let step = 0; step <= this.text.length; step += 1) {
      const character = this.peek(0);
      if (character !== ' ' && character !== '\t') {
        return;
      }
      this.position += 1;
    }
  }

  /** Whether the next characters end the line: a line feed, a carriage return and line feed, or the end. */
  atLineEnd(): boolean {
    assert(this.position <= this.text.length, 'The line end is asked inside the text');
    assert(this.position >= 0, 'The line end is asked at a real position');
    const character = this.peek(0);
    return character === '' || character === '\n' || (character === '\r' && this.peek(1) === '\n');
  }

  consumeLineEnd(): void {
    assert(this.position <= this.text.length, 'The lexer is inside the text');
    assert(this.atLineEnd(), 'A line break is consumed only where a line ends');
    if (this.peek(0) === '\r') {
      this.position += 2;
    } else if (this.peek(0) === '\n') {
      this.position += 1;
    }
  }

  skipComment(): void {
    assert(this.peek(0) === '#', 'A comment starts at its hash');
    for (let step = 0; step <= this.text.length; step += 1) {
      if (this.atLineEnd()) {
        return;
      }
      if (this.peek(0) === '\r') {
        this.fail('syntax');
      }
      this.position += 1;
    }
  }

  /** Spaces, line breaks and comments, as between the items of an array. */
  skipTrivia(): void {
    assert(this.position <= this.text.length, 'Trivia is skipped inside the text');
    assert(this.position >= 0, 'Trivia is skipped from a real position');
    for (let step = 0; step <= this.text.length; step += 1) {
      const character = this.peek(0);
      if (character === ' ' || character === '\t' || character === '\n') {
        this.position += 1;
      } else if (character === '\r' && this.peek(1) === '\n') {
        this.position += 2;
      } else if (character === '#') {
        this.skipComment();
      } else {
        return;
      }
    }
  }

  keyPath(): readonly string[] {
    assert(this.position >= 0, 'A key path starts at a real position');
    assert(this.position <= this.text.length, 'A key path starts inside the text');
    const segments: string[] = [];
    for (let count = 0; count <= CODEX_TOML_LIMITS.keySegmentsMax; count += 1) {
      this.skipSpaces();
      segments.push(this.keySegment());
      this.skipSpaces();
      if (this.peek(0) !== '.') {
        return segments;
      }
      this.position += 1;
    }
    return this.fail('unsupported');
  }

  keySegment(): string {
    assert(this.position < this.text.length + 1, 'A key segment starts inside the text');
    assert(this.position >= 0, 'A key segment starts at a real position');
    const first = this.peek(0);
    if (first === '"') {
      return this.basicString();
    }
    if (first === "'") {
      return this.literalString();
    }
    const start = this.position;
    while (BARE_KEY_CHARACTER.test(this.peek(0))) {
      this.position += 1;
    }
    if (this.position === start) {
      this.fail('syntax');
    }
    return this.text.slice(start, this.position);
  }

  /** A one-line basic string; the position is on its opening quote. */
  basicString(): string {
    assert(this.peek(0) === '"', 'A basic string starts at its quote');
    assert(this.position < this.text.length, 'A basic string starts inside the text');
    this.position += 1;
    let value = '';
    for (let step = 0; step <= this.text.length; step += 1) {
      const character = this.peek(0);
      if (character === '"') {
        this.position += 1;
        return value;
      }
      if (character === '' || character === '\n' || character === '\r') {
        this.fail('syntax');
      }
      if (character === '\\') {
        value += this.escape();
      } else {
        value += character;
        this.position += 1;
      }
    }
    return this.fail('syntax');
  }

  /** One escape; the position is on its backslash. */
  escape(): string {
    assert(this.peek(0) === '\\', 'An escape starts at its backslash');
    assert(this.position < this.text.length, 'An escape starts inside the text');
    const letter = this.peek(1);
    const simple = SIMPLE_ESCAPES[letter];
    if (simple !== undefined) {
      this.position += 2;
      return simple;
    }
    const digits = letter === 'u' ? 4 : letter === 'U' ? 8 : 0;
    if (digits === 0) {
      return this.fail('syntax');
    }
    const hex = this.text.slice(this.position + 2, this.position + 2 + digits);
    if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
      return this.fail('syntax');
    }
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return this.fail('syntax');
    }
    this.position += 2 + digits;
    return String.fromCodePoint(code);
  }

  literalString(): string {
    assert(this.peek(0) === "'", 'A literal string starts at its quote');
    assert(this.position < this.text.length, 'A literal string starts inside the text');
    this.position += 1;
    const end = this.text.indexOf("'", this.position);
    const value = end === -1 ? '' : this.text.slice(this.position, end);
    if (end === -1 || value.includes('\n') || value.includes('\r')) {
      this.fail('syntax');
    }
    this.position = end + 1;
    return value;
  }

  /** A multi-line string; the position is on the first of its three opening quotes. */
  multilineString(quote: '"' | "'"): string {
    assert(this.peek(0) === quote, 'A multi-line string starts at its first quote');
    assert(this.peek(2) === quote, 'A multi-line string opens with three quotes');
    this.position += 3;
    if (this.peek(0) === '\n') {
      this.position += 1;
    } else if (this.peek(0) === '\r' && this.peek(1) === '\n') {
      this.position += 2;
    }
    let value = '';
    for (let step = 0; step <= this.text.length; step += 1) {
      const character = this.peek(0);
      if (character === '') {
        this.fail('syntax');
      }
      if (character === quote) {
        let run = 0;
        while (this.peek(run) === quote) {
          run += 1;
        }
        if (run >= 3) {
          if (run > 5) {
            this.fail('syntax');
          }
          value += quote.repeat(run - 3);
          this.position += run;
          return value;
        }
        value += quote.repeat(run);
        this.position += run;
      } else if (character === '\\' && quote === '"') {
        value += this.multilineEscape();
      } else {
        value += character;
        this.position += 1;
      }
    }
    return this.fail('syntax');
  }

  // A backslash at the end of a line swallows the break and the white space after it.
  multilineEscape(): string {
    assert(this.peek(0) === '\\', 'A multi-line escape starts at its backslash');
    assert(this.position < this.text.length, 'A multi-line escape starts inside the text');
    let ahead = 1;
    while (this.peek(ahead) === ' ' || this.peek(ahead) === '\t') {
      ahead += 1;
    }
    if (this.peek(ahead) === '\n' || (this.peek(ahead) === '\r' && this.peek(ahead + 1) === '\n')) {
      this.position += ahead;
      this.skipTrivia();
      return '';
    }
    return this.escape();
  }

  value(depth: number): TomlValue {
    if (depth > CODEX_TOML_LIMITS.depthMax) {
      this.fail('too-many');
    }
    const first = this.peek(0);
    if (first === '"' || first === "'") {
      const multiline = this.peek(1) === first && this.peek(2) === first;
      const value = multiline ? this.multilineString(first) : first === '"' ? this.basicString() : this.literalString();
      return { kind: 'string', value };
    }
    if (first === '[') {
      return this.array(depth);
    }
    if (first === '{') {
      return this.inlineTable(depth);
    }
    return this.token();
  }

  array(depth: number): TomlValue {
    assert(this.peek(0) === '[', 'An array starts at its bracket');
    assert(depth <= CODEX_TOML_LIMITS.depthMax, 'An array is entered within the depth limit');
    this.position += 1;
    const items: TomlValue[] = [];
    for (let count = 0; count <= CODEX_TOML_LIMITS.itemsMax; count += 1) {
      this.skipTrivia();
      if (this.peek(0) === ']') {
        this.position += 1;
        return { kind: 'array', items };
      }
      if (count === CODEX_TOML_LIMITS.itemsMax) {
        break;
      }
      items.push(this.value(depth + 1));
      this.skipTrivia();
      if (this.peek(0) === ',') {
        this.position += 1;
      } else if (this.peek(0) !== ']') {
        this.fail('syntax');
      }
    }
    return this.fail('too-many');
  }

  inlineTable(depth: number): TomlValue {
    assert(this.peek(0) === '{', 'An inline table starts at its brace');
    assert(depth <= CODEX_TOML_LIMITS.depthMax, 'An inline table is entered within the depth limit');
    this.position += 1;
    const entries: TomlInlineEntry[] = [];
    for (let count = 0; count <= CODEX_TOML_LIMITS.itemsMax; count += 1) {
      this.skipTrivia();
      if (this.peek(0) === '}') {
        this.position += 1;
        return { kind: 'table', entries };
      }
      if (count === CODEX_TOML_LIMITS.itemsMax) {
        break;
      }
      const path = this.keyPath();
      const key = path[0];
      if (path.length !== 1 || key === undefined) {
        this.fail('unsupported');
      }
      this.skipSpaces();
      this.expect('=');
      this.skipSpaces();
      if (entries.some((entry) => entry.key === key)) {
        this.fail('syntax');
      }
      entries.push({ key, value: this.value(depth + 1) });
      this.skipTrivia();
      if (this.peek(0) === ',') {
        this.position += 1;
      } else if (this.peek(0) !== '}') {
        this.fail('syntax');
      }
    }
    return this.fail('too-many');
  }

  expect(character: string): void {
    assert(character.length === 1, 'One character is expected at a time');
    assert(this.position >= 0, 'A character is expected at a real position');
    if (this.peek(0) !== character) {
      this.fail('syntax');
    }
    this.position += 1;
  }

  /** A boolean, a number or a date: read up to the next delimiter and checked against its shape. */
  token(): TomlValue {
    assert(this.position >= 0, 'A token starts at a real position');
    assert(this.position <= this.text.length, 'A token starts inside the text');
    const start = this.position;
    while (!TOKEN_END.has(this.peek(0))) {
      this.position += 1;
    }
    const word = this.text.slice(start, this.position);
    if (word === 'true' || word === 'false') {
      return { kind: 'boolean' };
    }
    if (INTEGER_TOKEN.test(word)) {
      return { kind: 'integer' };
    }
    if (FLOAT_TOKEN.test(word) || TIME_TOKEN.test(word)) {
      return { kind: 'other' };
    }
    this.position = start;
    return this.fail('syntax');
  }
}

interface TableDraft {
  readonly path: readonly string[];
  readonly array: boolean;
  readonly headerStart: number;
  readonly entries: TomlEntry[];
  contentEnd: number;
}

function lexDocument(text: string): CodexDocument {
  const lexer = new Lexer(text, text.startsWith('﻿') ? 1 : 0);
  const drafts: TableDraft[] = [];
  const rootEntries: TomlEntry[] = [];
  let entryCount = 0;
  for (let step = 0; step <= text.length; step += 1) {
    const lineStart = lexer.position;
    lexer.skipSpaces();
    const first = lexer.peek(0);
    if (first === '') {
      break;
    }
    if (first === '#') {
      lexer.skipComment();
    } else if (first === '[') {
      const draft = lexHeader(lexer, lineStart);
      drafts.push(draft);
      if (drafts.length > CODEX_TOML_LIMITS.tablesMax) {
        lexer.fail('too-many');
      }
      draft.contentEnd = endStatement(lexer);
      continue;
    } else if (first !== '\n' && first !== '\r') {
      const key = lexer.keyPath();
      lexer.skipSpaces();
      lexer.expect('=');
      lexer.skipSpaces();
      const valueStart = lexer.position;
      const value = lexer.value(0);
      const valueEnd = lexer.position;
      const lineEnd = endStatement(lexer);
      entryCount += 1;
      if (entryCount > CODEX_TOML_LIMITS.entriesMax) {
        lexer.fail('too-many');
      }
      const entry: TomlEntry = { key, value, lineStart, valueStart, valueEnd, lineEnd };
      const owner = drafts[drafts.length - 1];
      if (owner === undefined) {
        rootEntries.push(entry);
      } else {
        owner.entries.push(entry);
        owner.contentEnd = lineEnd;
      }
      continue;
    }
    if (!lexer.atLineEnd()) {
      lexer.fail('syntax');
    }
    lexer.consumeLineEnd();
  }
  assert(lexer.position >= text.length, 'The whole file was read');
  const eol = text.indexOf('\r\n') !== -1 && text.indexOf('\r\n') <= (text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')) ? '\r\n' : '\n';
  return { text, eol, tables: drafts, rootEntries };
}

function lexHeader(lexer: Lexer, lineStart: number): TableDraft {
  assert(lexer.peek(0) === '[', 'A header starts at its bracket');
  assert(lineStart <= lexer.position, 'A header starts on or after its line');
  const array = lexer.peek(1) === '[';
  lexer.advance(array ? 2 : 1);
  const path = lexer.keyPath();
  lexer.skipSpaces();
  lexer.expect(']');
  if (array) {
    lexer.expect(']');
  }
  return { path, array, headerStart: lineStart, entries: [], contentEnd: lexer.position };
}

// Ends a statement: trailing spaces and comment, then the line break. Answers where the line ended.
function endStatement(lexer: Lexer): number {
  assert(lexer.position <= lexer.text.length, 'A statement ends inside the text');
  assert(lexer.position >= 0, 'A statement ends at a real position');
  lexer.skipSpaces();
  if (lexer.peek(0) === '#') {
    lexer.skipComment();
  }
  if (!lexer.atLineEnd()) {
    lexer.fail('syntax');
  }
  const lineEnd = lexer.position;
  lexer.consumeLineEnd();
  return lineEnd;
}

interface Refusal {
  readonly code: CodexProblemCode;
  readonly offset: number;
}

// What the editor will not guess at, anywhere in the file.
function checkDocument(document: CodexDocument): Refusal | undefined {
  assert(document.tables.length <= CODEX_TOML_LIMITS.tablesMax, 'A scanned file is within the table limit');
  assert(document.rootEntries.length <= CODEX_TOML_LIMITS.entriesMax, 'A scanned file is within the entry limit');
  const seen = new Set<string>();
  for (const table of document.tables) {
    const offset = table.headerStart;
    const identity = JSON.stringify(table.path);
    if (!table.array) {
      if (seen.has(identity)) {
        return { code: 'duplicate-table', offset };
      }
      seen.add(identity);
    }
    if (table.path[0] === CODEX_SERVERS_TABLE && (table.array || table.path.length === 1 ? table.array || table.entries.length > 0 : false)) {
      return { code: 'unsupported', offset };
    }
    const repeated = repeatedKey(table.entries);
    if (repeated !== undefined) {
      return { code: 'syntax', offset: repeated };
    }
  }
  const rootRepeated = repeatedKey(document.rootEntries);
  if (rootRepeated !== undefined) {
    return { code: 'syntax', offset: rootRepeated };
  }
  const definesServers = document.rootEntries.find((entry) => entry.key[0] === CODEX_SERVERS_TABLE);
  if (definesServers !== undefined) {
    return { code: 'unsupported', offset: definesServers.lineStart };
  }
  return undefined;
}

function repeatedKey(entries: readonly TomlEntry[]): number | undefined {
  assert(entries.length <= CODEX_TOML_LIMITS.entriesMax, 'A table is within the entry limit');
  assert(
    entries.every((entry) => entry.key.length > 0),
    'Every entry has a key',
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = JSON.stringify(entry.key);
    if (seen.has(identity)) {
      return entry.lineStart;
    }
    seen.add(identity);
  }
  return undefined;
}

// Reading servers: the managed keys of each server's tables.

interface ServerGroup {
  readonly name: string;
  readonly main: TomlTable | undefined;
  /** The server's other tables, `[mcp_servers.<name>.<sub>…]`. */
  readonly subs: readonly TomlTable[];
  readonly tables: readonly TomlTable[];
}

function serverGroups(document: CodexDocument): ReadonlyMap<string, ServerGroup> {
  assert(document.tables.length <= CODEX_TOML_LIMITS.tablesMax, 'Groups are built from a bounded file');
  assert(document.eol === '\n' || document.eol === '\r\n', 'A scanned file has a line ending');
  const tablesByName = new Map<string, TomlTable[]>();
  for (const table of document.tables) {
    const name = table.path[1];
    if (table.path[0] === CODEX_SERVERS_TABLE && name !== undefined) {
      tablesByName.set(name, [...(tablesByName.get(name) ?? []), table]);
    }
  }
  const groups = new Map<string, ServerGroup>();
  for (const [name, tables] of tablesByName) {
    const main = tables.find((table) => table.path.length === 2);
    groups.set(name, { name, main, subs: tables.filter((table) => table.path.length > 2), tables });
  }
  return groups;
}

function isManagedKey(key: string | undefined): key is CodexManagedKey {
  return CODEX_MANAGED_KEYS.some((known) => known === key);
}

function isTableKey(key: string | undefined): key is CodexTableKey {
  return CODEX_TABLE_KEYS.some((known) => known === key);
}

function stringsOf(value: TomlValue): readonly string[] | undefined {
  assert(value.kind.length > 0, 'A value has a kind');
  assert(value.kind !== 'array' || value.items.length <= CODEX_TOML_LIMITS.itemsMax, 'An array is within the item limit');
  if (value.kind !== 'array') {
    return undefined;
  }
  const strings: string[] = [];
  for (const item of value.items) {
    if (item.kind !== 'string') {
      return undefined;
    }
    strings.push(item.value);
  }
  return strings;
}

function pairsOfInline(value: TomlValue): readonly McpPair[] | undefined {
  assert(value.kind.length > 0, 'A value has a kind');
  assert(value.kind !== 'table' || value.entries.length <= CODEX_TOML_LIMITS.itemsMax, 'An inline table is within the item limit');
  if (value.kind !== 'table') {
    return undefined;
  }
  const pairs: McpPair[] = [];
  for (const entry of value.entries) {
    if (entry.value.kind !== 'string') {
      return undefined;
    }
    pairs.push({ name: entry.key, value: entry.value.value });
  }
  return pairs;
}

function pairsOfEntries(entries: readonly TomlEntry[]): readonly McpPair[] | undefined {
  assert(entries.length <= CODEX_TOML_LIMITS.entriesMax, 'A table is within the entry limit');
  assert(
    entries.every((entry) => entry.lineStart <= entry.lineEnd),
    'An entry ends after it starts',
  );
  const pairs: McpPair[] = [];
  for (const entry of entries) {
    const name = entry.key[0];
    if (entry.key.length !== 1 || name === undefined || entry.value.kind !== 'string') {
      return undefined;
    }
    pairs.push({ name, value: entry.value.value });
  }
  return pairs;
}

type FieldsDraft = {
  readonly [Key in keyof CodexFields]?: CodexFields[Key];
};

// The managed keys of a server's tables, or `undefined` when one is the wrong shape or set twice.
function readFields(group: ServerGroup): CodexFields | undefined {
  let draft: FieldsDraft = {};
  const assigned = new Set<CodexManagedKey>();
  for (const entry of group.main?.entries ?? []) {
    const key = entry.key[0];
    if (!isManagedKey(key)) {
      continue;
    }
    const patch = entry.key.length === 1 && !assigned.has(key) ? readEntry(key, entry.value) : undefined;
    if (patch === undefined) {
      return undefined;
    }
    assigned.add(key);
    draft = { ...draft, ...patch };
  }
  for (const sub of group.subs) {
    const key = sub.path[2];
    if (!isManagedKey(key)) {
      continue;
    }
    const pairs = sub.path.length === 3 && isTableKey(key) && !sub.array && !assigned.has(key) ? pairsOfEntries(sub.entries) : undefined;
    if (pairs === undefined || !isTableKey(key)) {
      return undefined;
    }
    assigned.add(key);
    draft = { ...draft, ...tablePatch(key, pairs) };
  }
  return {
    command: draft.command,
    args: draft.args ?? [],
    envVars: draft.envVars ?? [],
    env: draft.env ?? [],
    url: draft.url,
    bearerTokenEnvVar: draft.bearerTokenEnvVar,
    httpHeaders: draft.httpHeaders ?? [],
    envHttpHeaders: draft.envHttpHeaders ?? [],
  };
}

function tablePatch(key: CodexTableKey, pairs: readonly McpPair[]): FieldsDraft {
  assert(isTableKey(key), 'A table patch is for a table key');
  assert(pairs.length <= CODEX_TOML_LIMITS.itemsMax, 'A table patch is within the item limit');
  if (key === 'env') {
    return { env: pairs };
  }
  return key === 'http_headers' ? { httpHeaders: pairs } : { envHttpHeaders: pairs };
}

// What one managed key says, or `undefined` when its value is the wrong shape.
function readEntry(key: CodexManagedKey, value: TomlValue): FieldsDraft | undefined {
  switch (key) {
    case 'command':
      return value.kind === 'string' ? { command: value.value } : undefined;
    case 'url':
      return value.kind === 'string' ? { url: value.value } : undefined;
    case 'bearer_token_env_var':
      return value.kind === 'string' ? { bearerTokenEnvVar: value.value } : undefined;
    case 'args': {
      const strings = stringsOf(value);
      return strings === undefined ? undefined : { args: strings };
    }
    case 'env_vars': {
      const strings = stringsOf(value);
      return strings === undefined ? undefined : { envVars: strings };
    }
    case 'env':
    case 'http_headers':
    case 'env_http_headers': {
      const pairs = pairsOfInline(value);
      return pairs === undefined ? undefined : tablePatch(key, pairs);
    }
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

// Changing: edits are planned as byte ranges of the original text, then spliced in one pass.

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Adds or replaces (`put`) or removes (`remove`) one server and returns the whole new text. The file is
 * scanned again here, so the caller passes only the text it read. On any refusal the answer is a problem
 * and nothing is produced.
 */
export function changeCodexToml(text: string, change: CodexChange): Result<string, CodexProblem> {
  if (!isMcpServerName(change.name)) {
    return err({ code: 'bad-name', line: undefined });
  }
  const scanned = scanCodexToml(text);
  if (!scanned.ok) {
    return scanned;
  }
  const document = scanned.value;
  const group = serverGroups(document).get(change.name);
  const planned = change.kind === 'remove' ? planRemove(document, group) : planPut(document, group, change);
  if (!planned.ok) {
    return planned;
  }
  const changed = applyEdits(text, planned.value);
  assert(changed.length <= text.length + MCP_LIMITS.fileBytesMax, 'A change cannot more than double the file');
  const rescanned = scanCodexToml(changed);
  assert(rescanned.ok || rescanned.error.code === 'too-large' || rescanned.error.code === 'too-many', 'A change leaves a file the scanner reads');
  if (!rescanned.ok) {
    return rescanned;
  }
  const after = codexServerEntries(rescanned.value).find((entry) => entry.name === change.name);
  assert((change.kind === 'put') === (after !== undefined), 'The server is there after a put and gone after a remove');
  return ok(changed);
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const ordered = edits.map((edit, order) => ({ edit, order })).sort((left, right) => left.edit.start - right.edit.start || left.order - right.order);
  let result = '';
  let cursor = 0;
  for (const { edit } of ordered) {
    assert(edit.start >= cursor, 'Edits do not overlap');
    assert(edit.end >= edit.start, 'An edit ends after it starts');
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

function planRemove(document: CodexDocument, group: ServerGroup | undefined): Result<readonly Edit[], CodexProblem> {
  if (group === undefined) {
    return err({ code: 'not-found', line: undefined });
  }
  return ok(group.tables.map((table) => deleteRange(document, table.headerStart, afterLineBreak(document.text, table.contentEnd))));
}

function afterLineBreak(text: string, offset: number): number {
  assert(offset >= 0, 'An offset is never negative');
  assert(offset <= text.length, 'An offset is inside the text');
  if (text[offset] === '\r' && text[offset + 1] === '\n') {
    return offset + 2;
  }
  return text[offset] === '\n' ? offset + 1 : offset;
}

// Deleting a block leaves the blank line that set it apart from its neighbour; the blank line before it
// goes too when what follows is blank or the end, so no double gap or dangling blank line remains.
function deleteRange(document: CodexDocument, start: number, end: number): Edit {
  const { text } = document;
  assert(start <= end, 'A deleted range ends after it starts');
  let from = start;
  const next = text[end];
  const followedByGap = next === undefined || next === '\n' || next === '\r';
  if (followedByGap && text[start - 1] === '\n') {
    const breakStart = text[start - 2] === '\r' ? start - 2 : start - 1;
    if (breakStart > 0 && text[breakStart - 1] === '\n') {
      from = breakStart;
    }
  }
  return { start: from, end, text: '' };
}

function planPut(
  document: CodexDocument,
  group: ServerGroup | undefined,
  change: Extract<CodexChange, { readonly kind: 'put' }>,
): Result<readonly Edit[], CodexProblem> {
  const mapped = toCodexFields(change.config);
  if (!mapped.ok) {
    return err({ code: 'unmappable', line: undefined });
  }
  if (group === undefined) {
    return ok([appendServer(document, change.name, mapped.value)]);
  }
  return planUpdate(document, group, mapped.value);
}

function serverBlock(document: CodexDocument, name: string, fields: CodexFields): string {
  const header = (suffix: string): string => `[${CODEX_SERVERS_TABLE}.${tomlKey(name)}${suffix}]`;
  const lines: string[] = [header('')];
  const scalar = (key: string, value: string | undefined): void => {
    if (value !== undefined) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  };
  const list = (key: string, values: readonly string[]): void => {
    if (values.length > 0) {
      lines.push(`${key} = ${listText(values)}`);
    }
  };
  scalar('command', fields.command);
  list('args', fields.args);
  list('env_vars', fields.envVars);
  scalar('url', fields.url);
  scalar('bearer_token_env_var', fields.bearerTokenEnvVar);
  const tables: readonly (readonly [CodexTableKey, readonly McpPair[]])[] = [
    ['env', fields.env],
    ['http_headers', fields.httpHeaders],
    ['env_http_headers', fields.envHttpHeaders],
  ];
  for (const [key, pairs] of tables) {
    if (pairs.length > 0) {
      lines.push('', header(`.${key}`), ...pairs.map((pair) => `${tomlKey(pair.name)} = ${tomlString(pair.value)}`));
    }
  }
  return lines.join(document.eol);
}

function listText(values: readonly string[]): string {
  assert(values.length <= CODEX_TOML_LIMITS.itemsMax, 'A written list is within the item limit');
  assert(
    values.every((value) => value.length <= MCP_LIMITS.argCharsMax),
    'A written list holds bounded strings',
  );
  return `[${values.map(tomlString).join(', ')}]`;
}

function inlineText(pairs: readonly McpPair[]): string {
  assert(pairs.length <= CODEX_TOML_LIMITS.itemsMax, 'A written inline table is within the item limit');
  assert(
    pairs.every((pair) => pair.name.length > 0),
    'Every written pair has a name',
  );
  return pairs.length === 0 ? '{}' : `{ ${pairs.map((pair) => `${tomlKey(pair.name)} = ${tomlString(pair.value)}`).join(', ')} }`;
}

// A new server goes at the end, after one blank line, and the file keeps ending the way it did unless it
// had no line break to build on.
function appendServer(document: CodexDocument, name: string, fields: CodexFields): Edit {
  const { text, eol } = document;
  const block = serverBlock(document, name, fields);
  const bodyLength = text.startsWith('﻿') ? text.length - 1 : text.length;
  if (bodyLength === 0) {
    return { start: text.length, end: text.length, text: block + eol };
  }
  let separator = '';
  if (!text.endsWith('\n')) {
    separator += eol;
  }
  const endsBlank = text.endsWith('\n\n') || text.endsWith('\n\r\n');
  if (!endsBlank) {
    separator += eol;
  }
  return { start: text.length, end: text.length, text: separator + block + eol };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  assert(left.length <= CODEX_TOML_LIMITS.itemsMax, 'The left list is bounded');
  assert(right.length <= CODEX_TOML_LIMITS.itemsMax, 'The right list is bounded');
  return left.length === right.length && left.every((item, at) => item === right[at]);
}

function sameValue(value: TomlValue, wanted: string | readonly string[]): boolean {
  assert(value.kind.length > 0, 'A compared value has a kind');
  assert(wanted.length <= MCP_LIMITS.argCharsMax, 'A wanted value is bounded');
  if (typeof wanted === 'string') {
    return value.kind === 'string' && value.value === wanted;
  }
  const strings = stringsOf(value);
  return strings !== undefined && sameStrings(strings, wanted);
}

function removeEntry(document: CodexDocument, entry: TomlEntry): Edit {
  assert(entry.lineStart <= entry.lineEnd, 'An entry ends after it starts');
  assert(entry.lineEnd <= document.text.length, 'An entry lies inside the text');
  return { start: entry.lineStart, end: afterLineBreak(document.text, entry.lineEnd), text: '' };
}

function planUpdate(document: CodexDocument, group: ServerGroup, fields: CodexFields): Result<readonly Edit[], CodexProblem> {
  const main = group.main;
  if (main === undefined) {
    return err({ code: 'unsupported', line: undefined });
  }
  // A managed key written in a shape the editor does not rewrite (dotted, or as its own deeper table).
  const dotted = main.entries.find((entry) => isManagedKey(entry.key[0]) && entry.key.length > 1);
  const stray = group.subs.find((sub) => isManagedKey(sub.path[2]) && (sub.path.length > 3 || sub.array || !isTableKey(sub.path[2])));
  if (dotted !== undefined || stray !== undefined) {
    return err({ code: 'unsupported', line: lineOf(document.text, dotted?.lineStart ?? stray?.headerStart ?? 0) });
  }
  const edits: Edit[] = [];
  const entryOf = (key: CodexManagedKey): TomlEntry | undefined => main.entries.find((entry) => entry.key.length === 1 && entry.key[0] === key);
  const planned: readonly (readonly [CodexManagedKey, string | readonly string[] | undefined])[] = [
    ['command', fields.command],
    ['args', fields.command === undefined ? undefined : fields.args],
    ['env_vars', fields.envVars.length === 0 ? undefined : mergedNames(entryOf('env_vars'), fields.envVars)],
    ['url', fields.url],
    ['bearer_token_env_var', fields.bearerTokenEnvVar],
  ];
  for (const [key, wanted] of planned) {
    const existing = entryOf(key);
    if (key === 'env_vars' && wanted === undefined) {
      // Forwarded names are only ever added: another tool or the person may rely on the rest.
      continue;
    }
    if (existing === undefined) {
      const skipEmpty = key === 'args' && Array.isArray(wanted) && wanted.length === 0;
      if (wanted !== undefined && !skipEmpty) {
        edits.push({ start: main.contentEnd, end: main.contentEnd, text: `${document.eol}${key} = ${valueText(wanted)}` });
      }
    } else if (wanted === undefined) {
      edits.push(removeEntry(document, existing));
    } else if (!sameValue(existing.value, wanted)) {
      edits.push({ start: existing.valueStart, end: existing.valueEnd, text: valueText(wanted) });
    }
  }
  const lastTable = group.tables.reduce((latest, table) => (table.headerStart > latest.headerStart ? table : latest), main);
  const tables: readonly (readonly [CodexTableKey, readonly McpPair[]])[] = [
    ['env', fields.env],
    ['http_headers', fields.httpHeaders],
    ['env_http_headers', fields.envHttpHeaders],
  ];
  for (const [key, pairs] of tables) {
    const sub = group.subs.find((table) => table.path[2] === key);
    const inline = entryOf(key);
    if (sub !== undefined && inline !== undefined) {
      return err({ code: 'unsupported', line: lineOf(document.text, inline.lineStart) });
    }
    if (sub !== undefined) {
      edits.push(...planSubTable(document, group.name, sub, pairs));
    } else if (inline !== undefined) {
      edits.push(...planInline(document, inline, pairs));
    } else if (pairs.length > 0) {
      const lines = [`[${CODEX_SERVERS_TABLE}.${tomlKey(group.name)}.${key}]`, ...pairs.map((pair) => `${tomlKey(pair.name)} = ${tomlString(pair.value)}`)];
      edits.push({ start: lastTable.contentEnd, end: lastTable.contentEnd, text: `${document.eol}${document.eol}${lines.join(document.eol)}` });
    }
  }
  return ok(edits);
}

function valueText(wanted: string | readonly string[]): string {
  assert(wanted.length <= MCP_LIMITS.argCharsMax, 'A written value is bounded');
  assert(wanted.length >= 0, 'A written value has a length');
  return typeof wanted === 'string' ? tomlString(wanted) : listText(wanted);
}

// The names already forwarded followed by any new ones: nothing the file forwards is dropped.
function mergedNames(existing: TomlEntry | undefined, wanted: readonly string[]): readonly string[] {
  assert(wanted.length <= CODEX_TOML_LIMITS.itemsMax, 'Wanted names are bounded');
  assert(
    wanted.every((name) => name.length > 0),
    'Every wanted name is not empty',
  );
  const current = existing === undefined ? [] : (stringsOf(existing.value) ?? []);
  return [...current, ...wanted.filter((name) => !current.includes(name))];
}

// Keeps each entry that already says the right thing, rewrites the ones that differ, drops the ones no
// longer wanted and adds the rest. Comments between entries stay.
function planSubTable(document: CodexDocument, serverName: string, sub: TomlTable, pairs: readonly McpPair[]): readonly Edit[] {
  if (pairs.length === 0) {
    return [deleteRange(document, sub.headerStart, afterLineBreak(document.text, sub.contentEnd))];
  }
  const edits: Edit[] = [];
  const present = new Set<string>();
  for (const entry of sub.entries) {
    const name = entry.key[0];
    const wanted = pairs.find((pair) => pair.name === name);
    if (wanted === undefined) {
      edits.push(removeEntry(document, entry));
    } else {
      present.add(wanted.name);
      if (!sameValue(entry.value, wanted.value)) {
        edits.push({ start: entry.valueStart, end: entry.valueEnd, text: tomlString(wanted.value) });
      }
    }
  }
  const added = pairs.filter((pair) => !present.has(pair.name));
  assert(serverName.length > 0, 'A sub-table belongs to a named server');
  for (const pair of added) {
    edits.push({ start: sub.contentEnd, end: sub.contentEnd, text: `${document.eol}${tomlKey(pair.name)} = ${tomlString(pair.value)}` });
  }
  return edits;
}

function planInline(document: CodexDocument, entry: TomlEntry, pairs: readonly McpPair[]): readonly Edit[] {
  assert(entry.valueStart <= entry.valueEnd, 'An inline value ends after it starts');
  assert(entry.valueEnd <= document.text.length, 'An inline value lies inside the text');
  if (pairs.length === 0) {
    return [removeEntry(document, entry)];
  }
  const current = pairsOfInline(entry.value);
  const same =
    current !== undefined && current.length === pairs.length && current.every((pair, at) => pair.name === pairs[at]?.name && pair.value === pairs[at]?.value);
  return same ? [] : [{ start: entry.valueStart, end: entry.valueEnd, text: inlineText(pairs) }];
}

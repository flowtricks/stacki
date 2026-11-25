// The project's `.mcp.json` as text with positions, and the edits the MCP tab makes to it. A person's
// file has its own indentation, key order, extra top-level keys and per-server fields that Stacki does
// not know (`timeout`, `oauth`, `disabled`, ...); a change to one server must not disturb any of that.
// So the file is never re-printed from a value: it is scanned into nodes that remember where in the
// text they begin and end, and an edit replaces, inserts or deletes exactly one region of the text.
// With no change the text is the same bytes; with a change every byte outside the touched region is the
// same bytes, including the line endings, the final newline and a byte-order mark.
//
// The scanner is strict JSON (Claude Code reads `.mcp.json` with a JSON parser, so comments and
// trailing commas are errors here too). It also refuses what `JSON.parse` would accept silently and
// lose: a repeated key inside one object. Every problem carries a code and a 1-based line and column,
// never the text of the file.
//
// Bounds: the file is at most MCP_LIMITS.fileBytesMax bytes, nests at most MCP_LIMITS.depthMax deep, and
// holds at most MCP_LIMITS.serversMax servers.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import {
  MCP_FILE_FIELD_NAMES,
  MCP_LIMITS,
  isMcpServerName,
  mcpConfigFromFileEntry,
  mcpFileFields,
  type McpProblem,
  type McpProblemCode,
  type McpServerConfig,
} from './mcpConfig';

export const MCP_FILE_NAME = '.mcp.json';

const SERVERS_KEY = 'mcpServers';
const DEFAULT_INDENT = '  ';
const INDENT_SPACES_MAX = 8;
const BYTE_ORDER_MARK = '﻿';

export const MCP_JSON_SYNTAX_REASONS = [
  'unexpected-token',
  'unexpected-end',
  'unterminated-string',
  'bad-string',
  'bad-number',
  'trailing-content',
  'trailing-comma',
  'expected-colon',
  'expected-key',
] as const;
export type McpJsonSyntaxReason = (typeof MCP_JSON_SYNTAX_REASONS)[number];

export type McpJsonIssueCode =
  | McpJsonSyntaxReason
  | McpProblemCode
  | 'duplicate-key'
  | 'too-large'
  | 'too-deep'
  | 'not-object'
  | 'servers-not-object'
  | 'too-many-servers'
  | 'bad-server-name';

/** What is wrong with the file and where; `path` is dotted from the root and may be empty. */
export interface McpJsonIssue {
  readonly code: McpJsonIssueCode;
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

interface ScalarNode {
  readonly kind: 'scalar';
  readonly start: number;
  readonly end: number;
  readonly value: string | number | boolean | undefined;
  readonly isNull: boolean;
}

interface MemberNode {
  readonly key: string;
  readonly keyStart: number;
  readonly value: JsonNode;
}

interface ObjectNode {
  readonly kind: 'object';
  readonly start: number;
  readonly end: number;
  readonly members: readonly MemberNode[];
}

interface ArrayNode {
  readonly kind: 'array';
  readonly start: number;
  readonly end: number;
  readonly items: readonly JsonNode[];
}

type JsonNode = ScalarNode | ObjectNode | ArrayNode;

/** A scanned `.mcp.json`: the text, where its pieces are, and how it is laid out. */
export interface McpJsonDocument {
  readonly text: string;
  /** Absent for an empty or blank file. */
  readonly root: ObjectNode | undefined;
  readonly servers: ObjectNode | undefined;
  readonly indent: string;
  readonly eol: '\n' | '\r\n';
}

/** One server as the file holds it. A malformed entry is listed, not dropped: the file is not rewritten around it. */
export type McpFileEntry =
  | { readonly name: string; readonly status: 'server'; readonly config: McpServerConfig }
  | { readonly name: string; readonly status: 'invalid'; readonly problem: McpProblem };

/** What a change to the file can fail with; the text is untouched in every case. */
export type McpJsonChangeError = 'invalid-name' | 'too-many-servers' | 'not-found' | 'too-large' | 'unreadable';

export type McpJsonChange =
  { readonly kind: 'upsert'; readonly name: string; readonly config: McpServerConfig } | { readonly kind: 'remove'; readonly name: string };

/** Scans `text`; a failure is the first problem found, with its position. */
export function scanMcpJson(text: string): Result<McpJsonDocument, McpJsonIssue> {
  if (new TextEncoder().encode(text).length > MCP_LIMITS.fileBytesMax) {
    return err({ code: 'too-large', path: '', line: 1, column: 1 });
  }
  const scanner = new Scanner(text);
  const parsed = scanner.document();
  if (!parsed.ok) {
    return parsed;
  }
  const root = parsed.value;
  if (root === undefined) {
    return ok({ text, root, servers: undefined, indent: detectIndent(text), eol: detectEol(text) });
  }
  const serversMember = root.members.find((member) => member.key === SERVERS_KEY);
  if (serversMember !== undefined && serversMember.value.kind !== 'object') {
    return err(issueAt(text, serversMember.value.start, 'servers-not-object', SERVERS_KEY));
  }
  const servers = serversMember === undefined ? undefined : serversMember.value.kind === 'object' ? serversMember.value : undefined;
  if (servers !== undefined && servers.members.length > MCP_LIMITS.serversMax) {
    return err(issueAt(text, servers.start, 'too-many-servers', SERVERS_KEY));
  }
  return ok({ text, root, servers, indent: detectIndent(text), eol: detectEol(text) });
}

/** The servers in the file, in file order. A name that is not a valid server name is reported by `mcpJsonIssues`. */
export function mcpFileEntries(document: McpJsonDocument): readonly McpFileEntry[] {
  const members = document.servers?.members ?? [];
  assert(members.length <= MCP_LIMITS.serversMax, 'A scanned document holds at most the server limit');
  return members.map((member): McpFileEntry => {
    const read = mcpConfigFromFileEntry(toData(member.value), `${SERVERS_KEY}.${member.key}`);
    return read.ok ? { name: member.key, status: 'server', config: read.value } : { name: member.key, status: 'invalid', problem: read.error };
  });
}

/**
 * Everything wrong with `text` as a `.mcp.json`, for the JSON view: the syntax problem alone when there
 * is one (nothing after it can be read), otherwise each server's problems at the line where the server begins.
 */
export function mcpJsonIssues(text: string): readonly McpJsonIssue[] {
  const scanned = scanMcpJson(text);
  if (!scanned.ok) {
    return [scanned.error];
  }
  const issues: McpJsonIssue[] = [];
  const members = scanned.value.servers?.members ?? [];
  for (const member of members) {
    if (!isMcpServerName(member.key)) {
      issues.push(issueAt(text, member.keyStart, 'bad-server-name', `${SERVERS_KEY}.${member.key}`));
      continue;
    }
    const read = mcpConfigFromFileEntry(toData(member.value), `${SERVERS_KEY}.${member.key}`);
    if (!read.ok) {
      issues.push(issueAt(text, positionOfPath(member, read.error.path), read.error.code, read.error.path));
    }
  }
  assert(issues.length <= members.length, 'At most one issue is reported per server');
  return issues;
}

/**
 * Applies one change and answers with the whole new text. Only the touched region differs from `text`:
 * an upsert of an existing server rewrites just the fields Stacki manages (`type`, `command`, `args`,
 * `env`, `url`, `headers`) and leaves every other field of that entry byte for byte; a change that
 * would not alter the entry returns `text` itself.
 */
export function changeMcpJson(text: string, change: McpJsonChange): Result<string, McpJsonChangeError> {
  if (!isMcpServerName(change.name)) {
    return err('invalid-name');
  }
  const scanned = scanMcpJson(text);
  if (!scanned.ok) {
    return err(scanned.error.code === 'too-large' ? 'too-large' : 'unreadable');
  }
  const document = scanned.value;
  const existing = document.servers?.members.find((member) => member.key === change.name);
  let next: Result<string, McpJsonChangeError>;
  if (change.kind === 'remove') {
    next = existing === undefined ? err('not-found') : ok(removeServer(document, change.name));
  } else if (existing === undefined) {
    next = (document.servers?.members.length ?? 0) >= MCP_LIMITS.serversMax ? err('too-many-servers') : ok(addServer(document, change.name, change.config));
  } else {
    next = ok(updateServer(document, change.name, change.config));
  }
  if (!next.ok) {
    return next;
  }
  if (next.value === text) {
    return next;
  }
  if (new TextEncoder().encode(next.value).length > MCP_LIMITS.fileBytesMax) {
    return err('too-large');
  }
  assertEdited(mcpFileEntries(document).length, next.value, change);
  return next;
}

// The pair of the plan's checks: the new text scans, and holds (or no longer holds) the server as planned.
function assertEdited(entriesBefore: number, after: string, change: McpJsonChange): void {
  const rescanned = scanMcpJson(after);
  assert(rescanned.ok, 'An edited .mcp.json scans');
  const entries = mcpFileEntries(rescanned.value);
  const found = entries.find((entry) => entry.name === change.name);
  if (change.kind === 'remove') {
    assert(found === undefined, 'A removed server is gone');
    assert(entries.length + 1 === entriesBefore, 'Removing a server removes exactly one');
    return;
  }
  assert(found !== undefined, 'An upserted server is present');
  assert(found.status === 'server', 'An upserted server reads back valid');
  assert(JSON.stringify(found.config) === JSON.stringify(change.config), 'An upserted server reads back as planned');
}

function addServer(document: McpJsonDocument, name: string, config: McpServerConfig): string {
  const { text } = document;
  if (document.root === undefined) {
    return newDocument(document, name, config);
  }
  if (document.servers === undefined) {
    const valueText = printAt(
      document,
      { [name]: mcpFileFields(config) },
      lineIndent(text, document.root.start) + (document.root.members.length === 0 ? '' : ''),
    );
    return insertMember(document, document.root, SERVERS_KEY, valueText);
  }
  const indentBase = lineIndent(text, document.servers.start);
  return insertMember(document, document.servers, name, printAt(document, mcpFileFields(config), indentBase + document.indent));
}

// A file with nothing in it becomes the usual shape.
function newDocument(document: McpJsonDocument, name: string, config: McpServerConfig): string {
  const { indent, eol } = document;
  const bom = document.text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const server = printAt(document, mcpFileFields(config), indent + indent);
  return `${bom}{${eol}${indent}"${SERVERS_KEY}": {${eol}${indent}${indent}${JSON.stringify(name)}: ${server}${eol}${indent}}${eol}}${eol}`;
}

function updateServer(document: McpJsonDocument, name: string, config: McpServerConfig): string {
  const member = document.servers?.members.find((candidate) => candidate.key === name);
  assert(member !== undefined, 'The server being updated is in the file');
  if (member.value.kind !== 'object') {
    // The entry is not an object (a malformed one): the whole value is replaced by the planned entry.
    return replaceRegion(
      document.text,
      member.value.start,
      member.value.end,
      printAt(document, mcpFileFields(config), lineIndent(document.text, member.keyStart)),
    );
  }
  const wanted = mcpFileFields(config);
  let text = document.text;
  // One field at a time, rescanning between: each edit moves every position after it.
  for (const field of MCP_FILE_FIELD_NAMES) {
    const scanned = scanMcpJson(text);
    assert(scanned.ok, 'A text edited by this module scans between its own edits');
    text = editField(scanned.value, name, field, wanted[field]);
  }
  return text;
}

function editField(document: McpJsonDocument, serverName: string, field: string, wanted: unknown): string {
  const server = document.servers?.members.find((candidate) => candidate.key === serverName)?.value;
  assert(server !== undefined, 'The server being edited is in the file');
  assert(server.kind === 'object', 'The server being edited is an object');
  const current = server.members.find((member) => member.key === field);
  if (current === undefined) {
    return wanted === undefined
      ? document.text
      : insertMember(document, server, field, printAt(document, wanted, lineIndent(document.text, server.start) + document.indent));
  }
  if (wanted === undefined) {
    return removeMember(document.text, server, field);
  }
  if (JSON.stringify(toData(current.value)) === JSON.stringify(wanted)) {
    return document.text;
  }
  return replaceRegion(document.text, current.value.start, current.value.end, printAt(document, wanted, lineIndent(document.text, current.keyStart)));
}

function removeServer(document: McpJsonDocument, name: string): string {
  const servers = document.servers;
  assert(servers !== undefined, 'A server is removed from an object that exists');
  return removeMember(document.text, servers, name);
}

function removeMember(text: string, object: ObjectNode, key: string): string {
  const at = object.members.findIndex((member) => member.key === key);
  const member = object.members[at];
  assert(member !== undefined, 'The member being removed is in the object');
  if (object.members.length === 1) {
    return replaceRegion(text, object.start, object.end, '{}');
  }
  const next = object.members[at + 1];
  if (next !== undefined) {
    // From this key to the next key: the comma and the gap between them go with it.
    return replaceRegion(text, member.keyStart, next.keyStart, '');
  }
  const previous = object.members[at - 1];
  assert(previous !== undefined, 'A last member of several has a previous one');
  return replaceRegion(text, previous.value.end, member.value.end, '');
}

function insertMember(document: McpJsonDocument, object: ObjectNode, key: string, valueText: string): string {
  const { text, eol, indent } = document;
  const keyed = `${JSON.stringify(key)}: ${valueText}`;
  const last = object.members[object.members.length - 1];
  if (last === undefined) {
    const close = lineIndent(text, object.start);
    return replaceRegion(text, object.start, object.end, `{${eol}${close}${indent}${keyed}${eol}${close}}`);
  }
  if (startsLine(text, last.keyStart)) {
    return replaceRegion(text, last.value.end, last.value.end, `,${eol}${lineIndent(text, last.keyStart)}${keyed}`);
  }
  return replaceRegion(text, last.value.end, last.value.end, `, ${keyed}`);
}

function replaceRegion(text: string, start: number, end: number, replacement: string): string {
  assert(start <= end, 'A region starts before it ends');
  assert(end <= text.length, 'A region lies inside the text');
  return text.slice(0, start) + replacement + text.slice(end);
}

// A value printed with the file's own indentation unit and line ending, its later lines starting at `base`.
function printAt(document: McpJsonDocument, value: unknown, base: string): string {
  const printed = JSON.stringify(value, undefined, document.indent === '\t' ? '\t' : document.indent);
  const lines = printed.split('\n');
  return lines.map((line, at) => (at === 0 ? line : base + line)).join(document.eol);
}

// The blanks at the start of the line holding `offset`.
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  let end = lineStart;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) {
    end += 1;
  }
  return text.slice(lineStart, end);
}

// Whether only blanks lie between the start of the line and `offset`.
function startsLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(lineStart, offset).trim().length === 0;
}

function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// The first indented line decides: a tab, or its count of spaces (at most eight).
function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  const blanks = match?.[1];
  if (blanks === undefined) {
    return DEFAULT_INDENT;
  }
  if (blanks.startsWith('\t')) {
    return '\t';
  }
  return ' '.repeat(Math.min(blanks.length, INDENT_SPACES_MAX));
}

// JSON null is data in a project's file: an unknown field holding it must print back as null, so it is kept as a flag.
function toData(node: JsonNode, depth = 0): unknown {
  assert(depth <= MCP_LIMITS.depthMax, 'A scanned node is no deeper than the scanner allows');
  if (node.kind === 'scalar') {
    // eslint-disable-next-line stacki/no-null -- JSON null is data in a project file, not absence
    return node.isNull ? null : node.value;
  }
  if (node.kind === 'array') {
    return node.items.map((item) => toData(item, depth + 1));
  }
  return Object.fromEntries(node.members.map((member) => [member.key, toData(member.value, depth + 1)]));
}

// The offset of the part of a server a problem names (`mcpServers.Sanity.url` is the `url` member), else the server's key.
function positionOfPath(server: MemberNode, path: string): number {
  const prefix = `${SERVERS_KEY}.${server.key}.`;
  if (server.value.kind === 'object' && path.startsWith(prefix)) {
    const field = path.slice(prefix.length).split('.')[0];
    const inner = server.value.members.find((member) => member.key === field);
    if (inner !== undefined) {
      return inner.keyStart;
    }
  }
  return server.keyStart;
}

function issueAt(text: string, offset: number, code: McpJsonIssueCode, path: string): McpJsonIssue {
  assert(offset >= 0, 'An issue lies after the start of the text');
  assert(offset <= text.length, 'An issue lies inside the text');
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { code, path, line, column };
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const LITERALS = ['true', 'false', 'null'] as const;

// A recursive-descent scanner over the text. Depth is bounded; every loop advances an offset toward the end.
class Scanner {
  readonly #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  document(): Result<ObjectNode | undefined, McpJsonIssue> {
    if (this.#text.startsWith(BYTE_ORDER_MARK)) {
      this.#at = 1;
    }
    this.#blanks();
    if (this.#at >= this.#text.length) {
      return ok(undefined);
    }
    const root = this.#value(0, '');
    if (!root.ok) {
      return root;
    }
    this.#blanks();
    if (this.#at < this.#text.length) {
      return err(this.#issue('trailing-content', ''));
    }
    if (root.value.kind !== 'object') {
      return err(issueAt(this.#text, root.value.start, 'not-object', ''));
    }
    return ok(root.value);
  }

  #issue(code: McpJsonIssueCode, path: string): McpJsonIssue {
    return issueAt(this.#text, Math.min(this.#at, this.#text.length), code, path);
  }

  #blanks(): void {
    const text = this.#text;
    while (this.#at < text.length) {
      const character = text[this.#at];
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
        this.#at += 1;
      } else {
        return;
      }
    }
  }

  #value(depth: number, path: string): Result<JsonNode, McpJsonIssue> {
    if (depth > MCP_LIMITS.depthMax) {
      return err(this.#issue('too-deep', path));
    }
    this.#blanks();
    const character = this.#text[this.#at];
    if (character === undefined) {
      return err(this.#issue('unexpected-end', path));
    }
    if (character === '{') {
      return this.#object(depth, path);
    }
    if (character === '[') {
      return this.#array(depth, path);
    }
    if (character === '"') {
      return this.#string(path);
    }
    return this.#word(path);
  }

  #object(depth: number, path: string): Result<ObjectNode, McpJsonIssue> {
    const start = this.#at;
    this.#at += 1;
    const members: MemberNode[] = [];
    this.#blanks();
    if (this.#text[this.#at] === '}') {
      this.#at += 1;
      return ok({ kind: 'object', start, end: this.#at, members });
    }
    // Each pass reads one member and advances past it, so the loop ends at the end of the text at the latest.
    for (let pass = 0; pass <= this.#text.length; pass += 1) {
      this.#blanks();
      if (this.#text[this.#at] !== '"') {
        return err(this.#issue(this.#text[this.#at] === '}' ? 'trailing-comma' : this.#at >= this.#text.length ? 'unexpected-end' : 'expected-key', path));
      }
      const keyStart = this.#at;
      const key = this.#string(path);
      if (!key.ok) {
        return key;
      }
      const keyText = key.value.kind === 'scalar' && typeof key.value.value === 'string' ? key.value.value : '';
      const memberPath = path === '' ? keyText : `${path}.${keyText}`;
      if (members.some((member) => member.key === keyText)) {
        return err(issueAt(this.#text, keyStart, 'duplicate-key', memberPath));
      }
      this.#blanks();
      if (this.#text[this.#at] !== ':') {
        return err(this.#issue(this.#at >= this.#text.length ? 'unexpected-end' : 'expected-colon', memberPath));
      }
      this.#at += 1;
      const value = this.#value(depth + 1, memberPath);
      if (!value.ok) {
        return value;
      }
      members.push({ key: keyText, keyStart, value: value.value });
      this.#blanks();
      const next = this.#text[this.#at];
      if (next === ',') {
        this.#at += 1;
      } else if (next === '}') {
        this.#at += 1;
        return ok({ kind: 'object', start, end: this.#at, members });
      } else {
        return err(this.#issue(next === undefined ? 'unexpected-end' : 'unexpected-token', memberPath));
      }
    }
    return err(this.#issue('unexpected-end', path));
  }

  #array(depth: number, path: string): Result<ArrayNode, McpJsonIssue> {
    const start = this.#at;
    this.#at += 1;
    const items: JsonNode[] = [];
    this.#blanks();
    if (this.#text[this.#at] === ']') {
      this.#at += 1;
      return ok({ kind: 'array', start, end: this.#at, items });
    }
    for (let pass = 0; pass <= this.#text.length; pass += 1) {
      this.#blanks();
      if (this.#text[this.#at] === ']') {
        return err(this.#issue('trailing-comma', path));
      }
      const item = this.#value(depth + 1, `${path}.${items.length}`);
      if (!item.ok) {
        return item;
      }
      items.push(item.value);
      this.#blanks();
      const next = this.#text[this.#at];
      if (next === ',') {
        this.#at += 1;
      } else if (next === ']') {
        this.#at += 1;
        return ok({ kind: 'array', start, end: this.#at, items });
      } else {
        return err(this.#issue(next === undefined ? 'unexpected-end' : 'unexpected-token', path));
      }
    }
    return err(this.#issue('unexpected-end', path));
  }

  #string(path: string): Result<ScalarNode, McpJsonIssue> {
    const start = this.#at;
    const text = this.#text;
    this.#at += 1;
    while (this.#at < text.length) {
      const character = text[this.#at];
      if (character === '\\') {
        this.#at += 2;
      } else if (character === '"') {
        this.#at += 1;
        return this.#decodeString(start, path);
      } else if (character === '\n' || character === '\r') {
        return err(this.#issue('unterminated-string', path));
      } else {
        this.#at += 1;
      }
    }
    this.#at = text.length;
    return err(this.#issue('unterminated-string', path));
  }

  // A string literal is decoded by the platform's own JSON reader: the one place JSON.parse is used, on a slice already known to be one string.
  #decodeString(start: number, path: string): Result<ScalarNode, McpJsonIssue> {
    try {
      const decoded: unknown = JSON.parse(this.#text.slice(start, this.#at));
      if (typeof decoded === 'string') {
        return ok({ kind: 'scalar', start, end: this.#at, value: decoded, isNull: false });
      }
    } catch {
      // Falls through to the position of the string.
    }
    return err(issueAt(this.#text, start, 'bad-string', path));
  }

  #word(path: string): Result<ScalarNode, McpJsonIssue> {
    const start = this.#at;
    const rest = this.#text.slice(start, start + 32);
    for (const literal of LITERALS) {
      if (rest.startsWith(literal)) {
        this.#at += literal.length;
        return ok({ kind: 'scalar', start, end: this.#at, value: literal === 'null' ? undefined : literal === 'true', isNull: literal === 'null' });
      }
    }
    const number = NUMBER_PATTERN.exec(this.#text.slice(start, start + 64));
    if (number !== null) {
      this.#at += number[0].length;
      return ok({ kind: 'scalar', start, end: this.#at, value: Number(number[0]), isNull: false });
    }
    const character = this.#text[start];
    const looksNumeric = character !== undefined && /[-0-9]/.test(character);
    return err(this.#issue(looksNumeric ? 'bad-number' : 'unexpected-token', path));
  }
}

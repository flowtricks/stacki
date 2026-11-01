// TOML, edited where it stands.
//
// The same data can be written several ways — an inline table on one line, a
// [section.header] block, a multi-line array — and a project picks the shape
// that reads best next to the rest of the file. A writer that re-emits the
// document normalises all of that into one shape: the fixture's pricing.toml
// keeps `limits = { projects = 1, … }` inline and its add-ons in
// [team.addOns.*] sub-tables, and re-emitting turns a two-word edit into a
// rewritten file with the header comment gone.
//
// So reading goes through a real parser and writing does not: the key is found
// where it lives — in a table, in a sub-table, inside an inline table — and
// only its value text is replaced.

import * as TOML from 'smol-toml';

import { LIMITS } from '../../../shared/core/limits';
import { toRecord } from '../../../shared/core/record';

const parseData = (text: string): unknown => TOML.parse(text);

const DELETE = Symbol('delete');

// TOML dates are a type of their own; the parser hands them back as objects
// that print as the literal the file held.
const isDateLike = (value: unknown): value is Date | { toISOString(): string } =>
  value instanceof Date || typeof toRecord(value)?.['toISOString'] === 'function';

function print(value: unknown, depth = 0): string {
  // The value arrives with an edit from the renderer. Nested deeper than any value that crosses
  // a boundary, it is refused rather than followed.
  if (depth > LIMITS.ipcDepthMax) {
    throw new Error('The value is nested too deeply to write.');
  }
  if (value === null || value === undefined) {
    return '""';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (isDateLike(value)) {
    return String(value.toISOString());
  }
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    return `[${list.map((item) => print(item, depth + 1)).join(', ')}]`;
  }
  const record = toRecord(value);
  if (record) {
    return `{ ${Object.entries(record)
      .map(([key, entry]) => `${printKey(key)} = ${print(entry, depth + 1)}`)
      .join(', ')} }`;
  }
  const text = String(value);
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const printKey = (key: string | number): string => (BARE_KEY.test(String(key)) ? String(key) : JSON.stringify(String(key)));

// Splits a table header into its path, respecting quoted segments.
function headerPath(header: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^.\s]+)/g;
  let match;
  while ((match = re.exec(header))) {
    const segment = match[1] ?? match[2] ?? match[3];
    if (segment !== undefined) {
      out.push(segment);
    }
  }
  return out;
}

interface TomlEntry {
  readonly path: readonly (string | number)[];
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

// Where each key sits: its path, the span of its value, and the span of the
// whole line, so an edit can replace one and a delete can remove the other.
// Array-of-tables sections ([[x]]) are indexed in the order they appear.
function index(text: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  const lines = text.split('\n');
  // Where each line starts, so a value that runs over several of them can say
  // which line to carry on from.
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position: number): number => {
    // The last line is the answer once no later line starts at or before the position.
    for (let at = 0; at + 1 < lineStarts.length; at++) {
      const nextStart = lineStarts[at + 1];
      if (nextStart !== undefined) {
        if (nextStart > position) {
          return at;
        }
      }
    }
    return Math.max(0, lineStarts.length - 1);
  };

  let table: (string | number)[] = [];
  const counts = new Map<string, number>();

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const start = lineStarts[li];
    if (line === undefined || start === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const arrayHeader = trimmed.match(/^\[\[([^\]]+)\]\]/);
    const arrayTarget = arrayHeader?.[1];
    if (arrayTarget !== undefined) {
      const path = headerPath(arrayTarget);
      const key = path.join('.');
      const at = counts.get(key) ?? -1;
      counts.set(key, at + 1);
      table = [...path, at + 1];
      continue;
    }
    const header = trimmed.match(/^\[([^\]]+)\]/);
    const headerTarget = header?.[1];
    if (headerTarget !== undefined) {
      table = headerPath(headerTarget);
      continue;
    }

    const assignment = line.match(/^(\s*)((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-])+)(\s*=\s*)/);
    const keyText = assignment?.[2];
    if (!assignment || keyText === undefined) {
      continue;
    }
    const valueStart = start + assignment[0].length;
    const valueEnd = spanEnd(text, valueStart);
    entries.push({
      path: [...table, ...headerPath(keyText)],
      valueStart,
      valueEnd,
      lineStart: start,
      lineEnd: Math.max(valueEnd, start + line.length),
    });
    // A value that ran past its own line — a multi-line array — has consumed
    // the lines it spans, so the scan carries on after it.
    if (valueEnd > start + line.length) {
      li = lineAt(valueEnd - 1);
    }
  }
  return entries;
}

// The end of the value that starts at `from`, following brackets and braces
// across lines and ignoring anything inside a string.
function spanEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | undefined = undefined;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      // The value started inside a table of its own: this brace closes the one
      // holding it, so the value ended before it.
      if (depth < 0) {
        return trimEnd(text, from, i);
      }
      if (depth === 0) {
        return i + 1;
      }
    } else if (depth === 0 && (ch === '#' || ch === '\n' || ch === ',')) {
      // A comma at this level only happens inside an inline table, where it is
      // what separates this value from the next key.
      return trimEnd(text, from, i);
    }
  }
  return text.length;
}

const trimEnd = (text: string, from: number, to: number): number => {
  let end = to;
  while (end > from && /\s/.test(text.charAt(end - 1))) {
    end--;
  }
  return end;
};

// An inline table is one value, so a key inside it is patched inside that text.
function patchInline(source: string, key: string | number, value: unknown): string | undefined {
  const re = new RegExp(`(${escape(printKey(key))}\\s*=\\s*)`, '');
  const match = source.match(re);
  if (!match || match[1] === undefined) {
    // Add it before the closing brace.
    const close = source.lastIndexOf('}');
    if (close === -1) {
      return undefined;
    }
    const body = source.slice(1, close).trim();
    const inner = body ? `${body}, ${printKey(key)} = ${print(value)}` : `${printKey(key)} = ${print(value)}`;
    return `{ ${inner} }`;
  }
  const at = match.index ?? 0; // defined by construction: the match was found in source
  const from = at + match[1].length;
  const to = spanEnd(source, from);
  const tail = source.slice(to);
  const end = /^\s*,/.test(tail) && value === DELETE ? to + tail.indexOf(',') + 1 : to;
  if (value === DELETE) {
    const before = source.slice(0, at).replace(/,\s*$/, '');
    return before + source.slice(end).replace(/^\s*,/, '');
  }
  return source.slice(0, from) + print(value) + source.slice(to);
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const samePath = (left: readonly (string | number)[], right: readonly (string | number)[]): boolean =>
  left.length === right.length && left.every((seg, i) => String(seg) === String(right[i]));

export interface Edit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

/**
 * Applies { path, value } edits to TOML source, replacing only the value text
 * each path names. Paths reach into inline tables. A key the file does not have
 * is appended to its table; a table the file does not have is added at the end.
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const { path, value, rename } of edits) {
    // A record here is a table, so its id is its header — and every sub-table
    // underneath it carries the same first segment.
    if (rename !== undefined) {
      const from = path.map(String);
      out = out.replace(/^([ \t]*)\[(\[?)([^\]]+)(\]?)\]/gm, (line, indent: string, open: string, header: string, close: string) => {
        const segments = headerPath(header);
        if (segments.length < from.length || from.some((seg, i) => segments[i] !== seg)) {
          return line;
        }
        const next = [...from.slice(0, -1), rename, ...segments.slice(from.length)];
        return `${indent}[${open}${next.map(printKey).join('.')}${close}]`;
      });
      continue;
    }
    const entries = index(out);
    const exact = entries.find((entry) => samePath(entry.path, path));
    if (exact) {
      if (value === DELETE) {
        const from = out.lastIndexOf('\n', exact.lineStart - 1) + 1;
        out = out.slice(0, from) + out.slice(Math.min(out.length, exact.lineEnd + 1));
      } else {
        out = out.slice(0, exact.valueStart) + print(value) + out.slice(exact.valueEnd);
      }
      continue;
    }

    // A key inside an inline table: the nearest ancestor that exists is the
    // value holding it.
    let inline: { entry: TomlEntry; rest: readonly (string | number)[] } | undefined = undefined;
    for (let cut = path.length - 1; cut > 0 && !inline; cut--) {
      const found = entries.find((entry) => samePath(entry.path, path.slice(0, cut)));
      if (found && out.charAt(found.valueStart) === '{') {
        inline = { entry: found, rest: path.slice(cut) };
      }
    }
    if (inline && inline.rest.length === 1) {
      const rest = inline.rest[0];
      const source = out.slice(inline.entry.valueStart, inline.entry.valueEnd);
      const patched = rest === undefined ? undefined : patchInline(source, rest, value);
      if (patched !== undefined) {
        out = out.slice(0, inline.entry.valueStart) + patched + out.slice(inline.entry.valueEnd);
        continue;
      }
    }
    if (value === DELETE) {
      continue;
    }

    // Nothing to patch: write it into its table, after the last key already
    // there, or as a new table at the end of the file.
    const tablePath = path.slice(0, -1);
    const key = path[path.length - 1];
    if (key === undefined) {
      continue; // an empty path names no key
    }
    const siblings = entries.filter((entry) => samePath(entry.path.slice(0, -1), tablePath));
    const last = siblings[siblings.length - 1];
    if (last) {
      const indent = out.slice(out.lastIndexOf('\n', last.lineStart - 1) + 1).match(/^[ \t]*/)?.[0] ?? '';
      const at = last.lineEnd;
      out = `${out.slice(0, at)}\n${indent}${printKey(key)} = ${print(value)}${out.slice(at)}`;
    } else {
      const header = tablePath.length ? `\n[${tablePath.map(printKey).join('.')}]\n` : '\n';
      out = `${out.replace(/\n*$/, '\n')}${header}${printKey(key)} = ${print(value)}\n`;
    }
  }
  return out;
}

export { parseData, applyEdits, DELETE };

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

const TOML = require('smol-toml');

const parseData = (text) => TOML.parse(text);

const DELETE = Symbol('delete');

// TOML dates are a type of their own; the parser hands them back as objects
// that print as the literal the file held.
const isDateLike = (v) => v instanceof Date || (v && typeof v.toISOString === 'function');

function print(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (isDateLike(value)) return String(value.toISOString ? value.toISOString() : value);
  if (Array.isArray(value)) return `[${value.map(print).join(', ')}]`;
  if (typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${printKey(k)} = ${print(v)}`)
      .join(', ')} }`;
  }
  const s = String(value);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const printKey = (key) => (BARE_KEY.test(key) ? key : JSON.stringify(key));

// Splits a table header into its path, respecting quoted segments.
function headerPath(header) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^.\s]+)/g;
  let m;
  while ((m = re.exec(header))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Where each key sits: its path, the span of its value, and the span of the
// whole line, so an edit can replace one and a delete can remove the other.
// Array-of-tables sections ([[x]]) are indexed in the order they appear.
function index(text) {
  const entries = [];
  const lines = text.split('\n');
  // Where each line starts, so a value that runs over several of them can say
  // which line to carry on from.
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (pos) => {
    let at = 0;
    while (at + 1 < lineStarts.length && lineStarts[at + 1] <= pos) at++;
    return at;
  };

  let table = [];
  const counts = new Map();

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const start = lineStarts[li];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const arrayHeader = trimmed.match(/^\[\[([^\]]+)\]\]/);
    if (arrayHeader) {
      const path = headerPath(arrayHeader[1]);
      const key = path.join('.');
      const at = counts.get(key) ?? -1;
      counts.set(key, at + 1);
      table = [...path, at + 1];
      continue;
    }
    const header = trimmed.match(/^\[([^\]]+)\]/);
    if (header) {
      table = headerPath(header[1]);
      continue;
    }

    const assignment = line.match(/^(\s*)((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-])+)(\s*=\s*)/);
    if (!assignment) continue;
    const valueStart = start + assignment[0].length;
    const valueEnd = spanEnd(text, valueStart);
    entries.push({
      path: [...table, ...headerPath(assignment[2])],
      valueStart,
      valueEnd,
      lineStart: start,
      lineEnd: Math.max(valueEnd, start + line.length),
    });
    // A value that ran past its own line — a multi-line array — has consumed
    // the lines it spans, so the scan carries on after it.
    if (valueEnd > start + line.length) li = lineAt(valueEnd - 1);
  }
  return entries;
}

// The end of the value that starts at `from`, following brackets and braces
// across lines and ignoring anything inside a string.
function spanEnd(text, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      // The value started inside a table of its own: this brace closes the one
      // holding it, so the value ended before it.
      if (depth < 0) return trimEnd(text, from, i);
      if (depth === 0) return i + 1;
    } else if (depth === 0 && (ch === '#' || ch === '\n' || ch === ',')) {
      // A comma at this level only happens inside an inline table, where it is
      // what separates this value from the next key.
      return trimEnd(text, from, i);
    }
  }
  return text.length;
}

const trimEnd = (text, from, to) => {
  let end = to;
  while (end > from && /\s/.test(text[end - 1])) end--;
  return end;
};

// An inline table is one value, so a key inside it is patched inside that text.
function patchInline(source, key, value) {
  const re = new RegExp(`(${escape(printKey(key))}\\s*=\\s*)`, '');
  const m = source.match(re);
  if (!m) {
    // Add it before the closing brace.
    const close = source.lastIndexOf('}');
    if (close === -1) return null;
    const body = source.slice(1, close).trim();
    const inner = body ? `${body}, ${printKey(key)} = ${print(value)}` : `${printKey(key)} = ${print(value)}`;
    return `{ ${inner} }`;
  }
  const from = m.index + m[1].length;
  const to = spanEnd(source, from);
  const end = source.slice(to).match(/^\s*,/) && value === DELETE ? to + source.slice(to).indexOf(',') + 1 : to;
  if (value === DELETE) {
    const before = source.slice(0, m.index).replace(/,\s*$/, '');
    return before + source.slice(end).replace(/^\s*,/, '');
  }
  return source.slice(0, from) + print(value) + source.slice(to);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const samePath = (a, b) => a.length === b.length && a.every((seg, i) => String(seg) === String(b[i]));

/**
 * Applies { path, value } edits to TOML source, replacing only the value text
 * each path names. Paths reach into inline tables. A key the file does not have
 * is appended to its table; a table the file does not have is added at the end.
 */
function applyEdits(text, edits) {
  let out = text;
  for (const { path, value, rename } of edits) {
    // A record here is a table, so its id is its header — and every sub-table
    // underneath it carries the same first segment.
    if (rename !== undefined) {
      const from = path.map(String);
      out = out.replace(/^([ \t]*)\[(\[?)([^\]]+)(\]?)\]/gm, (line, indent, open, header, close) => {
        const segments = headerPath(header);
        if (segments.length < from.length || from.some((seg, i) => segments[i] !== seg)) return line;
        const next = [...from.slice(0, -1), rename, ...segments.slice(from.length)];
        return `${indent}[${open}${next.map(printKey).join('.')}${close}]`;
      });
      continue;
    }
    const entries = index(out);
    const exact = entries.find((e) => samePath(e.path, path));
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
    let inline = null;
    for (let cut = path.length - 1; cut > 0 && !inline; cut--) {
      const found = entries.find((e) => samePath(e.path, path.slice(0, cut)));
      if (found && out[found.valueStart] === '{') inline = { entry: found, rest: path.slice(cut) };
    }
    if (inline && inline.rest.length === 1) {
      const source = out.slice(inline.entry.valueStart, inline.entry.valueEnd);
      const patched = patchInline(source, inline.rest[0], value);
      if (patched != null) {
        out = out.slice(0, inline.entry.valueStart) + patched + out.slice(inline.entry.valueEnd);
        continue;
      }
    }
    if (value === DELETE) continue;

    // Nothing to patch: write it into its table, after the last key already
    // there, or as a new table at the end of the file.
    const tablePath = path.slice(0, -1);
    const key = path[path.length - 1];
    const siblings = entries.filter((e) => samePath(e.path.slice(0, -1), tablePath));
    if (siblings.length) {
      const last = siblings[siblings.length - 1];
      const indent = out.slice(out.lastIndexOf('\n', last.lineStart - 1) + 1).match(/^[ \t]*/)[0];
      const at = last.lineEnd;
      out = `${out.slice(0, at)}\n${indent}${printKey(key)} = ${print(value)}${out.slice(at)}`;
    } else {
      const header = tablePath.length ? `\n[${tablePath.map(printKey).join('.')}]\n` : '\n';
      out = `${out.replace(/\n*$/, '\n')}${header}${printKey(key)} = ${print(value)}\n`;
    }
  }
  return out;
}

module.exports = { parseData, applyEdits, DELETE };

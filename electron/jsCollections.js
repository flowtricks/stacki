// Exported array-of-object constants in .ts/.js files, read and written as CMS
// collections — `export const WORK_ITEMS = [{ title: "…" }, …]` edits like a
// JSON collection does.
//
// This is a tolerant literal parser, not a JS engine. Evaluating the file would
// mean running the project's own code (and resolving its imports) just to read
// data, and would still leave nothing to write back through. So only plain
// literals are recognised; anything computed — a function call, a spread, an
// identifier reference — makes that collection read-only rather than silently
// rewriting it into something else.
//
// Only the array's own span is replaced on write, so everything around it —
// imports, comments above the export, other constants — is untouched.

const ID_KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * How a value that isn't a literal travels through the CMS: `{ __expr: "…" }`
 * holding the declaration's own source. The editor shows it in a code field
 * and writes it back verbatim, so `const year = new Date().getFullYear()`
 * stays computed instead of being flattened into whatever it evaluated to
 * once. The key is exported so the renderer can recognise one.
 */
const EXPR = '__expr';
const isExpr = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof v[EXPR] === 'string';

/**
 * Past the quoted run starting at `i`. A scanner, not a parser: it only needs
 * the end, so a template's `${…}` is stepped over rather than understood.
 */
function skipQuoted(src, i) {
  const q = src[i];
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (q === '`' && ch === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
          i = skipQuoted(src, i);
          continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === q) return i + 1;
    i += 1;
  }
  return i;
}

// What can only be the start of the next statement, never a continuation of
// this one — so an expression written across lines without semicolons still
// ends where it should.
const NEXT_STATEMENT = /^(?:(?:export|import|const|let|var|function|class|return|if|for|while|switch|try)\b|\}|---)/;

/**
 * End of the expression starting at `i`: its `;`, or the line break that ends
 * it when the file doesn't use semicolons.
 */
function scanStatement(src, i) {
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(src, i);
      continue;
    }
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth < 0) return i;
    } else if (ch === ';' && depth === 0) {
      return i;
    } else if (ch === '\n' && depth === 0) {
      const next = skipTrivia(src, i);
      if (next >= src.length || NEXT_STATEMENT.test(src.slice(next, next + 10))) return i;
    }
    i += 1;
  }
  return i;
}

function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    return i;
  }
}

class Unsupported extends Error {}

function parseString(src, i) {
  const quote = src[i];
  let out = '';
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (next === 'u') {
        // \uXXXX and \u{XXXXX}
        if (src[i + 2] === '{') {
          const close = src.indexOf('}', i + 3);
          out += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16));
          i = close + 1;
        } else {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        }
        continue;
      }
      out += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, next: i + 1 };
    // A template literal with a substitution isn't a constant — bail rather
    // than freezing whatever it happens to evaluate to right now.
    if (quote === '`' && ch === '$' && src[i + 1] === '{') throw new Unsupported('template expression');
    out += ch;
    i += 1;
  }
  throw new Unsupported('unterminated string');
}

function parseValue(src, i) {
  i = skipTrivia(src, i);
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') return parseString(src, i);
  if (ch === '[') {
    const arr = [];
    i = skipTrivia(src, i + 1);
    while (src[i] !== ']') {
      if (i >= src.length) throw new Unsupported('unterminated array');
      const v = parseValue(src, i);
      arr.push(v.value);
      i = skipTrivia(src, v.next);
      if (src[i] === ',') i = skipTrivia(src, i + 1);
    }
    return { value: arr, next: i + 1 };
  }
  if (ch === '{') {
    const obj = {};
    i = skipTrivia(src, i + 1);
    while (src[i] !== '}') {
      if (i >= src.length) throw new Unsupported('unterminated object');
      if (src.startsWith('...', i)) throw new Unsupported('spread');
      let key;
      if (src[i] === '"' || src[i] === "'") {
        const k = parseString(src, i);
        key = k.value;
        i = skipTrivia(src, k.next);
      } else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        if (!m) throw new Unsupported('computed or unusual key');
        key = m[0];
        i = skipTrivia(src, i + m[0].length);
      }
      if (src[i] !== ':') throw new Unsupported('shorthand or method');
      const v = parseValue(src, i + 1);
      obj[key] = v.value;
      i = skipTrivia(src, v.next);
      if (src[i] === ',') i = skipTrivia(src, i + 1);
    }
    return { value: obj, next: i + 1 };
  }
  const word = /^(true|false|null|undefined)\b/.exec(src.slice(i));
  if (word) {
    const v = { true: true, false: false, null: null, undefined: null }[word[1]];
    return { value: v, next: i + word[0].length };
  }
  const num = /^-?(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(src.slice(i));
  if (num) return { value: Number(num[0].replace(/_/g, '')), next: i + num[0].length };
  throw new Unsupported('not a literal');
}

/**
 * Options both scanners take:
 *   requireExport — only `export const` counts. A page's frontmatter has no
 *     exports, so scanning one passes false.
 *   allowPlainLists — a list of strings or numbers counts as a collection too.
 *     In a data file that's a constant, not content; in a page's frontmatter
 *     (`const rotatingWords = ["found.", …]`) it's exactly what's being edited.
 */
const declRe = (requireExport, tail) =>
  new RegExp(
    `${requireExport ? 'export\\s+' : '(?:^|[\\n;{])[ \\t]*(?:export\\s+)?'}const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*${tail}`,
    'g'
  );

/**
 * Every `export const NAME = [ … ]` whose array holds object literals.
 * Returns {name, data, start, end} where start/end bound the array text.
 * A collection whose contents aren't plain literals is returned with
 * `data: null` and a `reason`, so the UI can show it as read-only.
 */
function findCollections(source, opts = {}) {
  const { requireExport = true, allowPlainLists = false } = opts;
  const out = [];
  // `export const NAME` with an optional type annotation, then `= [`.
  const re = declRe(requireExport, '\\[');
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length - 1; // at the '['
    let parsed;
    try {
      parsed = parseValue(source, start);
    } catch (err) {
      out.push({ name: m[1], data: null, start, end: start, reason: err.message });
      continue;
    }
    const value = parsed.value;
    if (!Array.isArray(value)) continue;
    // A collection is a list of records; an array of bare strings is a
    // constant in a data file, but it is content in a page.
    const isRecords =
      value.length > 0 && value.every((v) => v && typeof v === 'object' && !Array.isArray(v));
    const isPlainList =
      allowPlainLists && value.every((v) => v === null || typeof v !== 'object');
    if (!isRecords && !isPlainList) continue;
    out.push({ name: m[1], data: value, start, end: parsed.next });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

const quote = (s) =>
  `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

function literal(value, indent, pad) {
  // A value the CMS is carrying as source rather than data — a computed const
  // (`new Date().getFullYear() - FOUNDED`) round-trips as the text it is.
  if (isExpr(value)) return value[EXPR];
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const inner = pad + indent;
    return `[\n${value.map((v) => inner + literal(v, indent, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  const pair = ([k, v]) => `${ID_KEY.test(k) ? k : quote(k)}: ${literal(v, indent, pad + indent)}`;
  // Keep short records on one line — that's how these files are written by
  // hand, and expanding every one would churn the whole file on first save.
  // WIDTH matches Prettier's default so re-saving a formatted file is a no-op;
  // +1 leaves room for the trailing comma the caller adds.
  const oneLine = `{ ${entries.map(pair).join(', ')} }`;
  if (pad.length + oneLine.length + 1 <= WIDTH && !oneLine.includes('\n')) return oneLine;
  const inner = pad + indent;
  return `{\n${entries
    .map(([k, v]) => {
      const key = ID_KEY.test(k) ? k : quote(k);
      const val = literal(v, indent, inner);
      // A value that can't fit beside its key drops to the next line, the way
      // Prettier breaks a long string — otherwise every long quote re-flows.
      if (!val.includes('\n') && inner.length + key.length + 2 + val.length + 1 > WIDTH) {
        return `${inner}${key}:\n${inner}${indent}${val}`;
      }
      return `${inner}${key}: ${val}`;
    })
    .join(',\n')},\n${pad}}`;
}

/** The array literal text for `data`, indented to sit at column 0 of a statement. */
function serializeCollection(data, indent = '  ') {
  if (!data.length) return '[]';
  return `[\n${data.map((row) => indent + literal(row, indent, indent)).join(',\n')},\n]`;
}

/** Replace one collection's array in `source`, leaving everything else alone. */
function replaceCollection(source, name, data, opts) {
  const found = findCollections(source, opts).find((c) => c.name === name);
  if (!found || found.data === null) return null;
  const indentMatch = /\n([ \t]+)\S/.exec(source);
  const indent = indentMatch ? (indentMatch[1][0] === '\t' ? '\t' : ' '.repeat(indentMatch[1].length)) : '  ';
  return source.slice(0, found.start) + serializeCollection(data, indent) + source.slice(found.end);
}

// ---------------------------------------------------------------------------
// Single values
// ---------------------------------------------------------------------------

/** The address suffix for a file's non-repeating exports. Not a valid
 *  identifier, so it can never collide with a real export name. */
const GENERAL = '*general';

/**
 * Every `export const NAME = <literal>` whose value is a single value rather
 * than a list of records — site name, url, a count. These have no rows to
 * repeat, so the CMS shows them together as one "General" record.
 */
function findScalarExports(source, opts = {}) {
  const out = [];
  const re = declRe(opts.requireExport !== false, '');
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length;
    let parsed;
    try {
      parsed = parseValue(source, start);
    } catch {
      // Computed — carried as its own source so it can still be seen and
      // edited, rather than being invisible.
      const end = scanStatement(source, start);
      const text = source.slice(start, end).trim();
      if (text) out.push({ name: m[1], value: { [EXPR]: text }, start, end: start + text.length, code: true });
      continue;
    }
    const v = parsed.value;
    // An array is a collection of its own; an object rides along here as a
    // group of fields.
    if (Array.isArray(v)) continue;
    out.push({ name: m[1], value: v, start, end: parsed.next });
  }
  return out;
}

/** A file's single values as one record, or null when it has none. */
function readGeneral(source, opts) {
  const found = findScalarExports(source, opts);
  if (!found.length) return null;
  const out = {};
  for (const f of found) out[f.name] = f.value;
  return out;
}

/**
 * Write changed single values back. Only the values that actually differ are
 * rewritten, and each is replaced in place — so an untouched export keeps its
 * exact formatting, including a string the file wrapped onto its own line.
 */
function writeGeneral(source, data, opts) {
  const found = findScalarExports(source, opts).filter((f) =>
    Object.prototype.hasOwnProperty.call(data, f.name)
  );
  let out = source;
  // Back to front, so each replacement can't shift the spans still to come.
  for (const f of [...found].reverse()) {
    const next = data[f.name];
    // Unchanged values keep their exact source text — compare by shape, since
    // an object or an expression is never identical by reference.
    if (isExpr(f.value) || isExpr(next)) {
      if (isExpr(next) && isExpr(f.value) && next[EXPR] === f.value[EXPR]) continue;
    } else if (next === f.value || JSON.stringify(next) === JSON.stringify(f.value)) {
      continue;
    }
    // Only the value itself is replaced. The span starts after whatever
    // whitespace the file used, so a string the file had wrapped onto its own
    // line stays wrapped, and one written inline stays inline.
    out = out.slice(0, f.start) + literal(next, '  ', '') + out.slice(f.end);
  }
  return out;
}

module.exports = {
  EXPR,
  isExpr,
  findCollections,
  replaceCollection,
  serializeCollection,
  findScalarExports,
  readGeneral,
  writeGeneral,
  GENERAL,
};

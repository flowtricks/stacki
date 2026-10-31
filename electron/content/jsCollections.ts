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

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { toRecord } from '../../shared/core/record';

// A template nested in a template's `${…}`, nested again: hand-written code
// stops after two or three. Past this bound the scanner treats the rest of the
// file as the quoted run, as it does an unterminated string.
const SCAN_LIMITS = { templateDepthMax: 64 } as const;

const ID_KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * How a value that isn't a literal travels through the CMS: `{ __expr: "…" }`
 * holding the declaration's own source. The editor shows it in a code field
 * and writes it back verbatim, so `const year = new Date().getFullYear()`
 * stays computed instead of being flattened into whatever it evaluated to
 * once. The key is exported so the renderer can recognise one.
 */
const EXPR = '__expr';

interface ExprMarker {
  readonly __expr: string;
}

const isExpr = (value: unknown): value is ExprMarker => typeof toRecord(value)?.[EXPR] === 'string';

/**
 * Past the quoted run starting at `i`. A scanner, not a parser: it only needs
 * the end, so a template's `${…}` is stepped over rather than understood.
 */
function skipQuoted(source: string, start: number, depth = 0): number {
  if (depth > SCAN_LIMITS.templateDepthMax) {
    return source.length;
  }
  const quote = source.charAt(start);
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source.charAt(i + 1) === '{') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const character = source.charAt(i);
        if (character === '"' || character === "'" || character === '`') {
          i = skipQuoted(source, i, depth + 1);
          continue;
        }
        if (character === '{') {
          depth += 1;
        } else if (character === '}') {
          depth -= 1;
        }
        i += 1;
      }
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

// What can only be the start of the next statement, never a continuation of
// this one — so an expression written across lines without semicolons still
// ends where it should.
const NEXT_STATEMENT =
  /^(?:(?:export|import|const|let|var|function|class|return|if|for|while|switch|try)\b|\}|---)/;

/**
 * End of the expression starting at `i`: its `;`, or the line break that ends
 * it when the file doesn't use semicolons.
 */
function scanStatement(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i);
      continue;
    }
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth < 0) {
        return i;
      }
    } else if (ch === ';' && depth === 0) {
      return i;
    } else if (ch === '\n' && depth === 0) {
      const next = skipTrivia(source, i);
      if (next >= source.length || NEXT_STATEMENT.test(source.slice(next, next + 10))) {
        return i;
      }
    }
    i += 1;
  }
  return i;
}

function skipTrivia(source: string, start: number): number {
  let i = start;
  // Every pass returns or moves past a comment, so the text length bounds it.
  for (let pass = 0; pass <= source.length; pass++) {
    while (i < source.length && /\s/.test(source.charAt(i))) {
      i += 1;
    }
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
  assert(false, 'Trivia ends within its text');
}

class Unsupported extends Error {}

interface Parsed {
  readonly value: unknown;
  readonly next: number;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

function parseString(source: string, start: number): { value: string; next: number } {
  const quote = source.charAt(start);
  let out = '';
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      if (next === 'u') {
        // \uXXXX and \u{XXXXX}
        if (source.charAt(i + 2) === '{') {
          const close = source.indexOf('}', i + 3);
          out += String.fromCodePoint(parseInt(source.slice(i + 3, close), 16));
          i = close + 1;
        } else {
          out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
          i += 6;
        }
        continue;
      }
      // A lone '\' at the end of input appended String(undefined) in the
      // untyped scanner (out += undefined). Unreachable in a file that
      // parses; preserved so the scanner stays total.
      out += SIMPLE_ESCAPES[next] ?? (next || String(undefined));
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value: out, next: i + 1 };
    }
    // A template literal with a substitution isn't a constant — bail rather
    // than freezing whatever it happens to evaluate to right now.
    if (quote === '`' && ch === '$' && source.charAt(i + 1) === '{') {
      throw new Unsupported('template expression');
    }
    out += ch;
    i += 1;
  }
  throw new Unsupported('unterminated string');
}

// One literal value starting at `start`. Arrays and objects nest, so `depth`
// counts the containers already open; the file is untrusted input, so past the
// bound the value is unsupported rather than an assertion.
function parseValue(source: string, start: number, depth = 0): Parsed {
  if (depth > LIMITS.ipcDepthMax) {
    throw new Unsupported('nested too deeply');
  }
  const i = skipTrivia(source, start);
  const ch = source.charAt(i);
  if (ch === '"' || ch === "'" || ch === '`') {
    return parseString(source, i);
  }
  if (ch === '[') {
    return parseArray(source, i, depth);
  }
  if (ch === '{') {
    return parseObject(source, i, depth);
  }
  const word = parseWord(source, i);
  if (word !== undefined) {
    return word;
  }
  const numberMatch = /^-?(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(
    source.slice(i),
  );
  if (numberMatch) {
    return { value: Number(numberMatch[0].replace(/_/g, '')), next: i + numberMatch[0].length };
  }
  // A name standing for something else — `image: dailyDevotionals`, the way an
  // imported asset is written. It is not a literal and never will be, so it
  // travels as the source it is (the same `{ __expr }` a computed constant
  // uses) and is written back the same name. Nothing is evaluated and nothing
  // is flattened; what the name refers to is the file's business, not this
  // file's.
  //
  // Only a name that IS the whole value: the next thing after it has to end
  // the value. `getTags()`, `a ? b : c` and `x + 1` all fail that test and
  // leave the collection read-only, which is where a value this cannot write
  // back belongs.
  const name = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(source.slice(i));
  if (name) {
    const after = skipTrivia(source, i + name[0].length);
    const at = source.charAt(after);
    if (after >= source.length || at === ',' || at === ']' || at === '}') {
      return { value: { [EXPR]: name[0] }, next: i + name[0].length };
    }
  }
  throw new Unsupported('not a literal');
}

// The array literal whose `[` is at `open`.
function parseArray(source: string, open: number, depth: number): Parsed {
  assert(source.charAt(open) === '[', 'parseArray: starts at its bracket');
  const items: unknown[] = [];
  let i = skipTrivia(source, open + 1);
  while (source.charAt(i) !== ']') {
    if (i >= source.length) {
      throw new Unsupported('unterminated array');
    }
    const value = parseValue(source, i, depth + 1);
    assert(value.next > i, 'parseArray: every item consumes source');
    items.push(value.value);
    i = skipTrivia(source, value.next);
    if (source.charAt(i) === ',') {
      i = skipTrivia(source, i + 1);
    }
  }
  return { value: items, next: i + 1 };
}

// The object literal whose `{` is at `open`. Only `key: value` pairs with a
// plain or quoted key; a spread, a shorthand or a method is unsupported.
function parseObject(source: string, open: number, depth: number): Parsed {
  assert(source.charAt(open) === '{', 'parseObject: starts at its brace');
  const record: Record<string, unknown> = {};
  let i = skipTrivia(source, open + 1);
  while (source.charAt(i) !== '}') {
    if (i >= source.length) {
      throw new Unsupported('unterminated object');
    }
    if (source.startsWith('...', i)) {
      throw new Unsupported('spread');
    }
    let key: string;
    const keyQuote = source.charAt(i);
    if (keyQuote === '"' || keyQuote === "'") {
      const quotedKey = parseString(source, i);
      key = quotedKey.value;
      i = skipTrivia(source, quotedKey.next);
    } else {
      const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      if (!match) {
        throw new Unsupported('computed or unusual key');
      }
      key = match[0];
      i = skipTrivia(source, i + match[0].length);
    }
    if (source.charAt(i) !== ':') {
      throw new Unsupported('shorthand or method');
    }
    const value = parseValue(source, i + 1, depth + 1);
    assert(value.next > i, 'parseObject: every value consumes source');
    record[key] = value.value;
    i = skipTrivia(source, value.next);
    if (source.charAt(i) === ',') {
      i = skipTrivia(source, i + 1);
    }
  }
  return { value: record, next: i + 1 };
}

// `true`, `false`, `null` and `undefined` at `at`, or undefined for any other
// text. The file's `null` and `undefined` both read as its own null: a data
// value the CMS shows and writes back as `null`, not our absence.
function parseWord(source: string, at: number): Parsed | undefined {
  const word = /^(true|false|null|undefined)\b/.exec(source.slice(at));
  const wordText = word?.[1];
  if (word === null || wordText === undefined) {
    return undefined;
  }
  const next = at + word[0].length;
  if (wordText === 'true') {
    return { value: true, next };
  }
  if (wordText === 'false') {
    return { value: false, next };
  }
  // eslint-disable-next-line stacki/no-null -- The file's own null: data it holds, not absence.
  return { value: null, next };
}

/**
 * Options both scanners take:
 *   requireExport — only `export const` counts. A page's frontmatter has no
 *     exports, so scanning one passes false.
 *   allowPlainLists — a list of strings or numbers counts as a collection too.
 *     In a data file that's one of its settings, shown as a list field in
 *     General; in a page's frontmatter (`const rotatingWords = ["found.", …]`)
 *     it's exactly what's being edited.
 */
interface ScanOptions {
  readonly requireExport?: boolean;
  readonly allowPlainLists?: boolean;
}

const declRe = (tail: string, { requireExport }: { readonly requireExport: boolean }): RegExp =>
  new RegExp(
    `${requireExport ? 'export\\s+' : '(?:^|[\\n;{])[ \\t]*(?:export\\s+)?'}` +
      `const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*${tail}`,
    'g',
  );

export interface Collection {
  readonly name: string;
  readonly data: unknown[] | undefined;
  readonly start: number;
  readonly end: number;
  readonly reason?: string;
}

/**
 * Every `export const NAME = [ … ]` whose array holds object literals.
 * Returns {name, data, start, end} where start/end bound the array text.
 * A collection whose contents aren't plain literals is returned with
 * `data: undefined` and a `reason`, so the UI can show it as read-only.
 */
function findCollections(source: string, options: ScanOptions = {}): Collection[] {
  const { requireExport = true, allowPlainLists = false } = options;
  const out: Collection[] = [];
  // `export const NAME` with an optional type annotation, then `= [`.
  const re = declRe('\\[', { requireExport });
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    const start = match.index + match[0].length - 1; // at the '['
    let parsed: Parsed;
    try {
      parsed = parseValue(source, start);
    } catch (error: unknown) {
      out.push({
        name,
        data: undefined,
        start,
        end: start,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const value = parsed.value;
    if (!Array.isArray(value)) {
      continue;
    }
    const list: unknown[] = value;
    // A collection is a list of records; an array of bare strings is a
    // setting in a data file (General's list field), but content in a page.
    const isRecords =
      list.length > 0 &&
      list.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
    const isPlainList =
      allowPlainLists && list.every((item) => item === null || typeof item !== 'object');
    if (!isRecords && !isPlainList) {
      continue;
    }
    out.push({ name, data: list, start, end: parsed.next });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

// Prettier's default print width, which is what the comment in `literal` below
// has always said this is measured against — but the number itself was never
// written down, so every record long enough to ask the question threw a
// ReferenceError instead of answering it, and the save failed.
const WIDTH = 80;

const quote = (value: unknown): string =>
  `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

// The source text for `value`. It came from the renderer, so its nesting is
// checked here rather than trusted: past the bound the write fails.
function literal(value: unknown, indent: string, pad: string, depth = 0): string {
  if (depth > LIMITS.ipcDepthMax) {
    throw new Error('literal: the value nests deeper than a file can hold');
  }
  // A value the CMS is carrying as source rather than data — a computed const
  // (`new Date().getFullYear() - FOUNDED`) round-trips as the text it is.
  if (isExpr(value)) {
    return value[EXPR];
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return quote(value);
  }
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    if (!list.length) {
      return '[]';
    }
    const inner = pad + indent;
    const items = list.map((item) => inner + literal(item, indent, inner, depth + 1));
    return `[\n${items.join(',\n')},\n${pad}]`;
  }
  const record = toRecord(value);
  if (!record) {
    return '{}';
  }
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return '{}';
  }
  const pair = ([name, value]: [string, unknown]): string =>
    `${ID_KEY.test(name) ? name : quote(name)}: ${literal(value, indent, pad + indent, depth + 1)}`;
  // Keep short records on one line — that's how these files are written by
  // hand, and expanding every one would churn the whole file on first save.
  // WIDTH matches Prettier's default so re-saving a formatted file is a no-op;
  // +1 leaves room for the trailing comma the caller adds.
  const oneLine = `{ ${entries.map(pair).join(', ')} }`;
  if (pad.length + oneLine.length + 1 <= WIDTH && !oneLine.includes('\n')) {
    return oneLine;
  }
  const inner = pad + indent;
  return `{\n${entries
    .map(([name, value]) => {
      const key = ID_KEY.test(name) ? name : quote(name);
      const rendered = literal(value, indent, inner, depth + 1);
      // A value that can't fit beside its key drops to the next line, the way
      // Prettier breaks a long string — otherwise every long quote re-flows.
      if (!rendered.includes('\n') && inner.length + key.length + 2 + rendered.length + 1 > WIDTH) {
        return `${inner}${key}:\n${inner}${indent}${rendered}`;
      }
      return `${inner}${key}: ${rendered}`;
    })
    .join(',\n')},\n${pad}}`;
}

/** The array literal text for `data`, indented to sit at column 0 of a statement. */
function serializeCollection(data: readonly unknown[], indent = '  '): string {
  if (!data.length) {
    return '[]';
  }
  return `[\n${data.map((row) => indent + literal(row, indent, indent)).join(',\n')},\n]`;
}

// How far a step in is, in this file. The collection's own rows answer it best:
// they are the lines being rewritten, so whatever they are indented by is what
// the file indents by. Asking the file at large gets the first indented line of
// anything — and in a page whose frontmatter opens with a block comment, that
// line is ` * …`, so a two-space file was rewritten one space in.
function indentOf(text: string, fallback: string): string {
  const re = /\n([ \t]+)(\S)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const lead = match[1];
    if (match[2] === '*' || lead === undefined) {
      continue; // the middle of a /* … */ block
    }
    return lead.charAt(0) === '\t' ? '\t' : ' '.repeat(lead.length);
  }
  return fallback;
}

/** Replace one collection's array in `source`, leaving everything else alone. */
function replaceCollection(
  source: string,
  name: string,
  data: readonly unknown[],
  options?: ScanOptions,
): string | undefined {
  const found = findCollections(source, options).find((collection) => collection.name === name);
  if (!found || found.data === undefined) {
    return undefined;
  }
  const indent = indentOf(source.slice(found.start, found.end), indentOf(source, '  '));
  return source.slice(0, found.start) + serializeCollection(data, indent) + source.slice(found.end);
}

// ---------------------------------------------------------------------------
// Single values
// ---------------------------------------------------------------------------

/** The address suffix for a file's non-repeating exports. Not a valid
 *  identifier, so it can never collide with a real export name. */
const GENERAL = '*general';

interface ScalarExport {
  readonly name: string;
  readonly value: unknown;
  readonly start: number;
  readonly end: number;
  readonly code?: boolean;
}

/**
 * Every `export const NAME = <literal>` whose value is a single value rather
 * than a list of records — site name, url, a count. These have no rows to
 * repeat, so the CMS shows them together as one "General" record.
 */
function findScalarExports(source: string, options: ScanOptions = {}): ScalarExport[] {
  const out: ScalarExport[] = [];
  const re = declRe('', { requireExport: options.requireExport !== false });
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    const start = match.index + match[0].length;
    let parsed: Parsed;
    try {
      parsed = parseValue(source, start);
    } catch {
      // Computed — carried as its own source so it can still be seen and
      // edited, rather than being invisible.
      const end = scanStatement(source, start);
      const text = source.slice(start, end).trim();
      if (text) {
        out.push({ name, value: { [EXPR]: text }, start, end: start + text.length, code: true });
      }
      continue;
    }
    const value = parsed.value;
    // A list of records is a collection of its own; an object rides along here
    // as a group of fields. A list of plain values — `SERMON_SERVICES =
    // ["Sunday Service", …]` — is one setting with several items, a list field,
    // except where the scan makes such lists collections (a page's frontmatter).
    if (Array.isArray(value) && !isPlainValues(value, options)) {
      continue;
    }
    out.push({ name, value: value, start, end: parsed.next });
  }
  return out;
}

function isPlainValues(list: readonly unknown[], options: ScanOptions): boolean {
  if (options.allowPlainLists === true) {
    return false;
  }
  return list.every((item) => item === null || typeof item !== 'object');
}

/** A file's single values as one record, or undefined when it has none. */
function readGeneral(source: string, options?: ScanOptions): Record<string, unknown> | undefined {
  const found = findScalarExports(source, options);
  if (!found.length) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const scalar of found) {
    out[scalar.name] = scalar.value;
  }
  return out;
}

/**
 * Write changed single values back. Only the values that actually differ are
 * rewritten, and each is replaced in place — so an untouched export keeps its
 * exact formatting, including a string the file wrapped onto its own line.
 */
function writeGeneral(
  source: string,
  data: Record<string, unknown>,
  options?: ScanOptions,
): string {
  const found = findScalarExports(source, options).filter((scalar) =>
    Object.prototype.hasOwnProperty.call(data, scalar.name),
  );
  let out = source;
  // Back to front, so each replacement can't shift the spans still to come.
  for (const scalar of [...found].reverse()) {
    const next = data[scalar.name];
    // Unchanged values keep their exact source text — compare by shape, since
    // an object or an expression is never identical by reference.
    if (isExpr(scalar.value) || isExpr(next)) {
      if (isExpr(next) && isExpr(scalar.value) && next[EXPR] === scalar.value[EXPR]) {
        continue;
      }
    } else if (next === scalar.value || JSON.stringify(next) === JSON.stringify(scalar.value)) {
      continue;
    }
    // Only the value itself is replaced. The span starts after whatever
    // whitespace the file used, so a string the file had wrapped onto its own
    // line stays wrapped, and one written inline stays inline.
    out = out.slice(0, scalar.start) + literal(next, '  ', '') + out.slice(scalar.end);
  }
  return out;
}

export {
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

// Heuristic static analysis powering the loop "Data" suggestions: top-level
// frontmatter declarations and imports, ancestor loop variables, and — by
// reading object literals — the keys nested inside them, so `service`
// suggests `service.tags` without executing any code.

import { toRecord, toArray } from '../shared/record';

function skipString(code: string, i: number): number {
  const q = code.charAt(i);
  i++;
  while (i < code.length && code.charAt(i) !== q) {
    if (code.charAt(i) === '\\') {
      i++;
    }
    i++;
  }
  return i;
}

// End index (exclusive) of an expression starting at `start`: stops at a
// top-level ';' or a newline not continued by a chained operator.
function scanValue(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
      if (depth < 0) {
        return i;
      }
    } else if (depth === 0 && ch === ';') {
      return i;
    } else if (depth === 0 && ch === '\n') {
      if (!/^\s*(\.|\)|\]|\}|,|\|\||&&|\?|:)/.test(code.slice(i))) {
        return i;
      }
    }
  }
  return code.length;
}

// Top-level const/let/var declarations: name -> value text.
export function parseDeclarations(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (name === undefined) {
      continue;
    }
    const start = m.index + m[0].length;
    const end = scanValue(code, start);
    out.set(name, code.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

export interface DeclarationSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly statement: string;
  readonly value: string;
}

// Locates one top-level declaration by name and reports where it sits, so a
// prop bound to `{rotatingWords}` can offer to edit the `const rotatingWords
// = […]` behind it. `start`/`end` bound the whole statement (its indentation
// stays outside the range, and a trailing ';' inside it).
export function findDeclaration(code: unknown, name: unknown): DeclarationSpan | null {
  const src = String(code || '');
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return null;
  }
  const re = new RegExp(
    `(?:^|\\n)([ \\t]*)((?:export\\s+)?(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\s*=\\s*)`,
    'g',
  );
  const m = re.exec(src);
  const lead = m?.[1];
  const head = m?.[2];
  if (!m || lead === undefined || head === undefined) {
    return null;
  }
  const valueStart = m.index + m[0].length;
  const start = valueStart - head.length;
  const valueEnd = scanValue(src, valueStart);
  const end = src.charAt(valueEnd) === ';' ? valueEnd + 1 : valueEnd;
  return {
    name: ident,
    start,
    end,
    statement: src.slice(start, end),
    value: src.slice(valueStart, valueEnd).trim(),
  };
}

/**
 * The import that brings `name` into a file, as {name, spec}, or null.
 * Covers `import x from`, `import { a, b as c } from`, `import * as ns from`
 * and type-only imports — everything a page's frontmatter can carry.
 */
export function findImportOf(code: unknown, name: unknown): { name: string; spec: string } | null {
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return null;
  }
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(code || ''))) !== null) {
    const clause = m[1];
    const spec = m[2];
    if (clause === undefined || spec === undefined) {
      continue;
    }
    // `* as ns` and a default binding are the whole name; a braced list needs
    // its entries split, honouring `a as b` (the local name is what's used).
    const braced = clause.match(/\{([\s\S]*)\}/);
    const names: string[] = [];
    const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+/, '');
    for (const part of outside.split(',')) {
      const t = part.trim();
      if (t) {
        names.push(t);
      }
    }
    const bracedBody = braced?.[1];
    if (bracedBody !== undefined) {
      for (const part of bracedBody.split(',')) {
        const t = part.trim();
        if (!t) {
          continue;
        }
        const as = t.split(/\s+as\s+/);
        names.push((as[1] || as[0] || '').trim());
      }
    }
    if (names.includes(ident)) {
      return { name: ident, spec };
    }
  }
  return null;
}

// The first '{…}' object inside an array literal (or the object itself).
export function firstObjectIn(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const t = text.trim();
  if (t.startsWith('{')) {
    return t;
  }
  if (!t.startsWith('[')) {
    return null;
  }
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i);
      continue;
    }
    if (ch === '{' && depth === 1) {
      let d = 0;
      for (let j = i; j < t.length; j++) {
        const c = t.charAt(j);
        if (c === '"' || c === "'" || c === '`') {
          j = skipString(t, j);
          continue;
        }
        if (c === '{') {
          d++;
        } else if (c === '}') {
          d--;
          if (d === 0) {
            return t.slice(i, j + 1);
          }
        }
      }
      return null;
    }
    if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
    }
  }
  return null;
}

export interface ObjectEntry {
  readonly key: string;
  readonly value: string;
}

// Top-level entries of an object literal: [{key, value}]. Shorthand keys
// ({ name, url }) yield empty value text.
export function objectEntries(text: string | null | undefined): ObjectEntry[] {
  if (!text) {
    return [];
  }
  const t = text.trim();
  if (!t.startsWith('{')) {
    return [];
  }
  const entries: ObjectEntry[] = [];
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i) + 1;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth++;
      i++;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && /[,{\s]/.test(t.charAt(i - 1) || '{')) {
      const m = t.slice(i).match(/^([\w$]+)\s*(:)?/);
      const key = m?.[1];
      if (m && key !== undefined && (m[2] || /^[\w$]+\s*[,}]/.test(t.slice(i)))) {
        if (!m[2]) {
          entries.push({ key, value: '' });
          i += key.length;
          continue;
        }
        const vs = i + m[0].length;
        let d = depth;
        let j = vs;
        while (j < t.length) {
          const c = t.charAt(j);
          if (c === '"' || c === "'" || c === '`') {
            j = skipString(t, j) + 1;
            continue;
          }
          if ('([{'.includes(c)) {
            d++;
          } else if (')]}'.includes(c)) {
            d--;
            if (d === 0) {
              break;
            }
          } else if (c === ',' && d === 1) {
            break;
          }
          j++;
        }
        entries.push({ key, value: t.slice(vs, j).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return entries;
}

function kindOf(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const t = value.trim();
  if (t.startsWith('[')) {
    return 'list';
  }
  if (t.startsWith('{')) {
    return 'object';
  }
  if (/^['"`]/.test(t)) {
    return 'text';
  }
  if (/^-?\d/.test(t)) {
    return 'number';
  }
  if (/^(true|false)$/.test(t)) {
    return 'boolean';
  }
  return '';
}

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

// Modules that can't be looped over, by what they are rather than by naming
// luck: markup, styles, and media. A PascalCase default import is Astro's
// component convention, which catches the rest.
const NON_DATA_EXT =
  /\.(astro|md|mdx|css|s[ac]ss|less|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mov|woff2?|ttf|otf)(\?.*)?$/i;

// The framework's own modules hold functions and types — `getCollection`,
// `render`, `GetStaticPaths`. They are how data is FETCHED, never data itself,
// and every content page imports four of them, so unfiltered they crowd out
// the values underneath.
const TOOL_MODULE = /^(astro(:|$)|node:)/;

interface ImportLike {
  readonly name?: string;
  readonly path?: string;
}

function mayHoldData(imp: ImportLike | null | undefined): boolean {
  const path = String(imp?.path || '');
  if (NON_DATA_EXT.test(path) || TOOL_MODULE.test(path)) {
    return false;
  }
  return !/^[A-Z]/.test(String(imp?.name || ''));
}

// Splits `a, b = {x: 1}, ...rest` on its top-level commas — a destructuring
// pattern's parts, with nested objects, arrays and strings left alone.
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// First `ch` at the top level of `text`, or -1 — the `:` of a rename and the
// `=` of a default, without tripping over either inside a default value.
function topIndexOf(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (c === ch && depth === 0) {
      return i;
    }
  }
  return -1;
}

export interface Destructure {
  readonly name: string;
  readonly from: string;
  readonly kind: string;
}

/**
 * Top-level destructuring declarations: `const { theme = "inherit", overlap }
 * = Astro.props` and `const { Content, headings } = await render(post)`.
 * parseDeclarations only reads `const name =`, which misses both — and the
 * first of those is where a component's own props live, the very thing a
 * child's prop is usually bound to.
 *
 * Returns [{name, from, kind}] where `from` is the text being destructured
 * and `name` is the LOCAL name (`{ title: heading }` binds `heading`).
 */
export function parseDestructures(code: unknown): Destructure[] {
  const src = String(code || '');
  const out: Destructure[] = [];
  const re = /(?:^|[\n;])\s*(?:export\s+)?(?:const|let|var)\s*\{/g;
  while (re.exec(src) !== null) {
    const open = re.lastIndex - 1;
    // The pattern's own closing brace, then the `=` that must follow it —
    // without which this is a block, not a declaration.
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const c = src.charAt(i);
      if (c === '"' || c === "'" || c === '`') {
        i = skipString(src, i);
        continue;
      }
      if ('([{'.includes(c)) {
        depth++;
      } else if (')]}'.includes(c)) {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      break;
    }
    re.lastIndex = close + 1;
    const eq = src.slice(close + 1).match(/^\s*=\s*/);
    if (!eq) {
      continue;
    }
    const valueStart = close + 1 + eq[0].length;
    const from = src.slice(valueStart, scanValue(src, valueStart)).trim();
    for (const part of splitTopLevel(src.slice(open + 1, close))) {
      const t = part.trim();
      if (!t) {
        continue;
      }
      if (t.startsWith('...')) {
        const rest = t.slice(3).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(rest)) {
          out.push({ name: rest, from, kind: 'rest' });
        }
        continue;
      }
      const colon = topIndexOf(t, ':');
      let local = colon === -1 ? t : t.slice(colon + 1);
      const eqAt = topIndexOf(local, '=');
      const def = eqAt === -1 ? '' : local.slice(eqAt + 1).trim();
      local = (eqAt === -1 ? local : local.slice(0, eqAt)).trim();
      // A nested pattern (`{ data: { title } }`) binds names one level down —
      // this reads the flat cases, and skips what it can't name.
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) {
        continue;
      }
      out.push({ name: local, from, kind: kindOf(def) });
    }
  }
  return out;
}

// A declaration holding a function rather than data — `export const
// getStaticPaths = (async () => {…})`. Offering it as something to bind to is
// noise, and every page has one.
function looksCallable(value: unknown): boolean {
  const raw = String(value || '').trim();
  const test = (t: string): boolean =>
    /^(async\s+)?function\b/.test(t) ||
    /^(async\s*)?\([^()]*\)\s*(:[^=]*)?=>/.test(t) ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(t);
  // Both as written and with an opening paren dropped: `(href) => …` is an
  // arrow, and so is the `(async () => {…}) satisfies GetStaticPaths` that
  // wraps one.
  return test(raw) || test(raw.replace(/^\(\s*/, ''));
}

// `await getCollection("blog")`, `getEntry("author", id)` — the collection a
// declaration reads, when it names one outright.
const COLLECTION_CALL = /\b(getCollection|getEntry|getEntries)\s*\(\s*['"]([\w-]+)['"]/;

export function collectionCallIn(text: unknown): { fn: string; name: string } | null {
  const m = String(text || '').match(COLLECTION_CALL);
  const fn = m?.[1];
  const name = m?.[2];
  return fn !== undefined && name !== undefined ? { fn, name } : null;
}

// `getEntry(post.data.author)` — a reference, which names no collection in the
// line itself. What it points AT does: an Astro reference value is
// {id, collection}, so the answer is in the data the editor already has.
const REF_CALL = /\b(getEntry|getEntries)\s*\(\s*([\w$]+(?:\.[\w$]+)*(?:\[\d+\])?)\s*\)/;

export function referenceCallIn(text: unknown): { fn: string; path: string } | null {
  const m = String(text || '').match(REF_CALL);
  const fn = m?.[1];
  const path = m?.[2];
  return fn !== undefined && path !== undefined ? { fn, path } : null;
}

/** The value at a dotted path inside sampled data: `post.data.author` → {id, collection}. */
export function sampleAt(sample: unknown, path: unknown): unknown {
  let cur: unknown = sample;
  for (const step of String(path || '').split('.')) {
    const m = step.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (!m) {
      return undefined;
    }
    const name = m[1];
    if (name) {
      const record = toRecord(cur);
      if (!record) {
        return undefined;
      }
      cur = record[name];
    }
    for (const idx of m[2]?.match(/\d+/g) ?? []) {
      const list = toArray(cur);
      if (!list) {
        return undefined;
      }
      cur = list[Number(idx)];
    }
  }
  return cur;
}

// What an Astro reference looks like once it is data: the entry it points to,
// named by collection and id, with nothing loaded yet.
const isRef = (v: unknown): v is { id: string; collection: string } => {
  const record = toRecord(v);
  return (
    record !== undefined &&
    typeof record['id'] === 'string' &&
    typeof record['collection'] === 'string' &&
    record['data'] === undefined
  );
};

/** How a fetched entry is keyed. One per collection+id, so refs to the same entry share. */
export const sampleKey = (collection: string, id?: string): string =>
  id ? `${collection}#${id}` : collection;

export interface ReferenceNeed {
  readonly key: string;
  readonly collection: string;
  readonly id: string;
}

/**
 * The entries this file resolves by reference — `const author = await
 * getEntry(post.data.author)` — as {key, collection, id} to fetch. Needs the
 * props sample, since the reference's target is in the data, not the source.
 */
export function referencesInScope(frontmatter: string | null | undefined, propsSample: unknown): ReferenceNeed[] {
  if (!propsSample) {
    return [];
  }
  const out: ReferenceNeed[] = [];
  const seen = new Set<string>();
  const consider = (valueText: string): void => {
    const call = referenceCallIn(valueText);
    if (!call) {
      return;
    }
    const at = sampleAt(propsSample, call.path);
    const list = toArray(at);
    const ref = list ? list.find(isRef) : at;
    if (!isRef(ref)) {
      return;
    }
    const key = sampleKey(ref.collection, ref.id);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ key, collection: ref.collection, id: ref.id });
  };
  for (const [, value] of parseDeclarations(frontmatter ?? '')) {
    consider(value);
  }
  for (const d of parseDestructures(frontmatter ?? '')) {
    consider(d.from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sampled data, as something to show: what a value IS, and what is inside it.
// ---------------------------------------------------------------------------

// The markers the dev-server sampler leaves behind for what JSON can't hold.
// See PATHS_ENDPOINT in electron/main.js.
const marker = (v: unknown): string | null => {
  const tag = toRecord(v)?.['__stacki'];
  return typeof tag === 'string' ? tag : null;
};

export function sampleKind(v: unknown): string {
  if (v === null || v === undefined) {
    return 'empty';
  }
  if (Array.isArray(v)) {
    return 'list';
  }
  if (typeof v === 'object') {
    return marker(v) ?? 'object';
  }
  if (typeof v === 'string') {
    return 'text';
  }
  if (typeof v === 'number') {
    return 'number';
  }
  if (typeof v === 'boolean') {
    return 'boolean';
  }
  return 'empty';
}

// Bookkeeping Astro puts on a content entry: where the file is, what its hash
// is, the rendered HTML. Real keys, and never what anyone means to bind — they
// would sit at the top of every entry, above the fields that matter.
const ENTRY_INTERNALS = new Set([
  'filePath',
  'digest',
  'rendered',
  'deferredRender',
  'legacyId',
  'assetImports',
]);
const isEntry = (v: Record<string, unknown>): boolean =>
  'collection' in v && 'data' in v;
const shownKeys = (v: unknown): string[] => {
  const record = toRecord(v) ?? {};
  return isEntry(record) ? Object.keys(record).filter((k) => !ENTRY_INTERNALS.has(k)) : Object.keys(record);
};

const clip = (text: unknown, max: number): string =>
  String(text).length > max ? `${String(text).slice(0, max)}…` : String(text);

// One line saying what a value IS — the thing a designer reads down the right
// of the picker to find the field they mean. A container says how much is in
// it rather than showing a wall of JSON; that's what expanding it is for.
export function samplePreview(v: unknown): string {
  const kind = sampleKind(v);
  if (kind === 'date') {
    const value = toRecord(v)?.['value'];
    return value ? String(value).slice(0, 10) : 'date';
  }
  if (kind === 'deep') {
    return 'deeper…';
  }
  if (kind === 'more') {
    return `${String(toRecord(v)?.['count'])} more`;
  }
  if (kind === 'empty') {
    return '—';
  }
  if (kind === 'text') {
    return v === '' ? '""' : clip(`"${String(v)}"`, 42);
  }
  if (kind === 'number' || kind === 'boolean') {
    return String(v);
  }
  if (kind === 'list') {
    const list = toArray(v) ?? [];
    const more = list.find((x) => marker(x) === 'more');
    const shown = list.length - (more ? 1 : 0);
    const count = toRecord(more)?.['count'];
    const total = more ? shown + (typeof count === 'number' ? count : 0) : shown;
    return `${total} ${total === 1 ? 'item' : 'items'}`;
  }
  const keys = shownKeys(v);
  return keys.length ? `${keys.length} ${keys.length === 1 ? 'field' : 'fields'}` : '{}';
}

const MAX_TREE_DEPTH = 6;

export interface TreeNode {
  path: string;
  key: string;
  kind: string;
  preview: string;
  children: TreeNode[] | null;
  section?: string;
  nav?: { index: number; count: number };
  query?: { collection: string; name: string };
  lazy?: boolean;
}

// A value the app has actually seen — every key is real, so the tree is the
// data rather than a guess at it.
function fromSample(value: unknown, base: string, depth: number): TreeNode[] | null {
  if (depth >= MAX_TREE_DEPTH) {
    return null;
  }
  const kind = sampleKind(value);
  if (kind === 'object') {
    const record = toRecord(value) ?? {};
    return shownKeys(value).map((k) => sampleNode(`${base}.${k}`, k, record[k], depth + 1));
  }
  if (kind === 'list') {
    return (toArray(value) ?? [])
      .map((v, i) =>
        marker(v) === 'more' ? null : sampleNode(`${base}[${i}]`, String(i), v, depth + 1),
      )
      .filter((n): n is TreeNode => n !== null);
  }
  return null;
}

function sampleNode(path: string, key: string, value: unknown, depth: number): TreeNode {
  const children = fromSample(value, path, depth);
  return {
    path,
    key,
    kind: sampleKind(value),
    preview: samplePreview(value),
    children: children && children.length ? children : null,
  };
}

const MAX_LITERAL_DEPTH = 4;

// No live data, but the source says the shape outright: `const site = { … }`.
// A list contributes its FIRST item, which is the only one whose shape is
// knowable — and the one a loop over it will be handed.
function fromLiteral(text: unknown, base: string, depth: number): TreeNode[] | null {
  if (depth >= MAX_LITERAL_DEPTH) {
    return null;
  }
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    const entries = objectEntries(t);
    return entries.length
      ? entries.map((e) => literalNode(`${base}.${e.key}`, e.key, e.value, depth + 1))
      : null;
  }
  if (t.startsWith('[')) {
    const first = firstObjectIn(t);
    if (!first) {
      return null;
    }
    const item = literalNode(`${base}[0]`, '0', first, depth + 1);
    return item.children ? [item] : null;
  }
  return null;
}

function literalNode(path: string, key: string, valueText: unknown, depth: number): TreeNode {
  const t = String(valueText || '').trim();
  const kind = kindOf(t) || 'value';
  const children = fromLiteral(t, path, depth);
  return {
    path,
    key,
    kind,
    // A literal IS its value, so it shows it. Anything else is an expression
    // — `await getEntry(post.data.author)` — and putting that in the value
    // column is showing a designer the code the picker exists to avoid.
    preview: kind === 'text' || kind === 'number' || kind === 'boolean' ? clip(t, 42) : '',
    children: children && children.length ? children : null,
  };
}

// Stamped on the queries Stacki writes itself, so it can take them away again
// when the last thing using them goes — and never take away one that was
// written by hand.
export const QUERY_MARK = 'stacki:query';

export interface MarkedQuery {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** Those queries, as {name, start, end} spans in the frontmatter text. */
export function markedQueries(frontmatter: string | null | undefined): MarkedQuery[] {
  const out: MarkedQuery[] = [];
  const re = new RegExp(
    `^[ \\t]*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^\\n]*?//\\s*${QUERY_MARK}[ \\t]*$`,
    'gm',
  );
  let m;
  while ((m = re.exec(frontmatter ?? '')) !== null) {
    const name = m[1];
    if (name !== undefined) {
      out.push({ name, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/**
 * The frontmatter without one of them — the line and the break that carried
 * it, so taking a query back leaves the file exactly as it was before the
 * query was added, rather than a blank line where it used to be.
 */
export function removeMarkedQuery(frontmatter: string, name: string): string {
  const found = markedQueries(frontmatter).find((q) => q.name === name);
  if (!found) {
    return frontmatter;
  }
  const src = String(frontmatter);
  let { start, end } = found;
  if (start > 0 && src.charAt(start - 1) === '\n') {
    start -= 1;
  } else if (src.charAt(end) === '\n') {
    end += 1;
  }
  return src.slice(0, start) + src.slice(end);
}

/**
 * The collection queries this file already has: collection name → the
 * identifier holding it. What makes picking from a collection twice reuse the
 * first query instead of writing a second one for the same content.
 */
export function queriesInScope(frontmatter: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of parseDeclarations(frontmatter ?? '')) {
    // `export const getStaticPaths = async () => { … getCollection("blog") … }`
    // mentions a collection without holding one. Binding to it would name a
    // function where a list was meant.
    if (looksCallable(value)) {
      continue;
    }
    const call = collectionCallIn(value);
    if (call?.fn === 'getCollection' && !out.has(call.name)) {
      out.set(call.name, name);
    }
  }
  return out;
}

/** Every name the frontmatter already binds — what an auto-named query must avoid. */
export function namesInScope(
  frontmatter: string | null | undefined,
  imports: readonly ImportLike[] | null | undefined,
): Set<string> {
  const taken = new Set<string>();
  for (const [name] of parseDeclarations(frontmatter ?? '')) {
    taken.add(name);
  }
  for (const d of parseDestructures(frontmatter ?? '')) {
    taken.add(d.name);
  }
  for (const i of imports ?? []) {
    if (i.name !== undefined) {
      taken.add(i.name);
    }
  }
  return taken;
}

export interface DataContext {
  readonly frontmatter?: string;
  readonly imports?: readonly ImportLike[];
  readonly ancestorHeads?: readonly string[];
  readonly propsSample?: unknown;
  readonly propsSchema?: readonly SchemaField[];
  readonly collectionSamples?: Record<string, unknown>;
  readonly collections?: readonly { readonly name: string; readonly count?: number }[];
  readonly itemIndex?: Record<string, number>;
}

export interface SchemaField {
  readonly name: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly shape?: readonly { readonly name: string; readonly type?: string }[];
  readonly shapeIsList?: boolean;
}

/**
 * The names an expression field can offer while it is typed, for the scope it
 * sits in: this file's props, its frontmatter values, the item of any loop
 * around it — the same things the data picker lists, flattened into labels and
 * carrying their preview as the note beside each one.
 *
 * Frontmatter names the tree leaves out (functions, imported components) come
 * after them: the picker can't offer those because they aren't data, but a
 * condition or an expression is free to name any of them.
 */
export function scopeCompletions(context: DataContext = {}): { label: string; detail: string }[] {
  const out: { label: string; detail: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string | undefined, detail: string): void => {
    if (!label || seen.has(label)) {
      return;
    }
    seen.add(label);
    out.push({ label, detail });
  };
  const walk = (nodes: readonly TreeNode[] | null | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      add(node.path, node.preview ? String(node.preview).slice(0, 40) : node.section ?? '');
      // One level in is the useful depth: `post.data` earns its place, every
      // field of every collection does not — the picker is for browsing.
      if (depth < 2 && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  try {
    walk(dataTree(context), 0);
  } catch {
    /* a half-written frontmatter parses to nothing; the names below still do */
  }
  for (const name of namesInScope(context.frontmatter ?? '', context.imports ?? [])) {
    add(name, 'frontmatter');
  }
  return out;
}

export interface ScopeChip {
  readonly from: number;
  readonly to: number;
  readonly path: string;
}

const TYPE_OPERATORS = new Set(['as', 'satisfies']);

function isTypeSyntaxIdentifier(source: string, from: number, root: string): boolean {
  if (TYPE_OPERATORS.has(root)) {
    return true;
  }
  const before = source.slice(0, from).trimEnd();
  return /(?:^|[^\w$])(?:as|satisfies)$/.test(before);
}

/**
 * The names an expression NAMES, as ranges, so a field can draw them as chips.
 *
 * `render && (content || background)` is three values and some punctuation; the
 * three are what the reader is looking for, and until now they were the same
 * grey as the `&&` between them. Only names that are actually in scope count —
 * anything else is an ordinary identifier (a method, a global, a typo), and
 * drawing it as a value would say it is one.
 *
 * Strings are skipped: `"content"` is a word, not the prop of that name.
 */
export function scopeChips(text: unknown, names: Iterable<string> | Set<string> | null | undefined): ScopeChip[] {
  const src = String(text ?? '');
  const inScope = names instanceof Set ? names : new Set(names ?? []);
  if (!inScope.size) {
    return [];
  }
  const out: ScopeChip[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    // Skip over a string whole — quotes, escapes and all.
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length && src.charAt(i) !== ch) {
        i += src.charAt(i) === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (!/[A-Za-z_$]/.test(ch)) {
      i += 1;
      continue;
    }
    // A name, plus any `.field` chain hanging off it: `post.data.title` is one
    // value, not three.
    let j = i;
    while (j < src.length && /[\w$]/.test(src.charAt(j))) {
      j += 1;
    }
    while (src.charAt(j) === '.' && /[A-Za-z_$]/.test(src.charAt(j + 1))) {
      j += 1;
      while (j < src.length && /[\w$]/.test(src.charAt(j))) {
        j += 1;
      }
    }
    let path = src.slice(i, j);
    let end = j;
    // A call is the method, not the value: in `items.map(…)` the value is
    // `items`, so the chip stops before `.map`. `fn(…)` on its own chips nothing.
    if (src.slice(j).trimStart().startsWith('(')) {
      const cut = path.lastIndexOf('.');
      if (cut <= 0) {
        i = j;
        continue;
      }
      end = i + cut;
      path = path.slice(0, cut);
    }
    // Not a property of something else — the `data` in `post.data` is part of
    // that chip, not one of its own.
    const before = src.slice(0, i).trimEnd();
    const root = path.split('.')[0] ?? '';
    if (!before.endsWith('.') && inScope.has(root) && !isTypeSyntaxIdentifier(src, i, root)) {
      out.push({ from: i, to: end, path });
    }
    i = j;
  }
  return out;
}

/**
 * What to call the query for a collection: `blog` → `blogEntries`,
 * `case-studies` → `caseStudiesEntries`. Named for what it holds rather than
 * after the collection alone, so it doesn't read like a single entry — and
 * suffixed if the name is somehow already taken.
 */
export function autoQueryName(collection: string, taken: ReadonlySet<string> = new Set()): string {
  const camel = String(collection)
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m: string, c?: string) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]+/, '');
  const base = `${camel || 'collection'}Entries`;
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; i < 50; i++) {
    if (!taken.has(`${base}${i}`)) {
      return `${base}${i}`;
    }
  }
  return `${base}X`;
}

/** Which collections this file reads by name — what the app fetches a sample entry for. */
export function collectionsInScope(frontmatter: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const [, value] of parseDeclarations(frontmatter ?? '')) {
    const c = collectionCallIn(value);
    if (c) {
      out.add(c.name);
    }
  }
  for (const d of parseDestructures(frontmatter ?? '')) {
    const c = collectionCallIn(d.from);
    if (c) {
      out.add(c.name);
    }
  }
  return [...out];
}

// `const { Content, headings } = await render(post)` — made while the page
// renders, so there is nothing to sample. The shape is Astro's own and fixed,
// and the field names are the point: a table of contents is built out of
// heading.depth and heading.slug. Names and types only; no invented values.
const RENDER_SHAPE: Record<string, readonly { key: string; kind: string }[]> = {
  headings: [
    { key: 'depth', kind: 'number' },
    { key: 'slug', kind: 'text' },
    { key: 'text', kind: 'text' },
  ],
};

function shapeNode(name: string, fields: readonly { key: string; kind: string }[]): TreeNode {
  const item: TreeNode = {
    path: `${name}[0]`,
    key: '0',
    kind: 'object',
    preview: '',
    children: fields.map((f) => ({
      path: `${name}[0].${f.key}`,
      key: f.key,
      kind: f.kind,
      preview: '',
      children: null,
    })),
  };
  return { path: name, key: name, kind: 'list', preview: '', children: [item] };
}

// `const toc = headings.filter(h => h.depth < 4)` — fewer of the same thing.
// Whatever `headings` turned out to be, `toc` is that too, so the fields under
// one belong under the other.
const KEEPS_SHAPE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*(filter|slice|sort|reverse|concat|toSorted|toReversed|flat)\s*\(/;

// `const featured = portfolio.find(…) ?? portfolio[0]` — ONE of the same thing.
// The picker knew `portfolio` was a list of entries and could open it, and knew
// nothing at all about `featured`: it offered it as a bare value with no fields
// under it, so the one entry the page is actually built around was the one
// thing you couldn't pick a title out of.
const PICKS_ONE =
  /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\.\s*(?:find|at|pop|shift)\s*\(|\[\s*\d+\s*\])/;

function addUnique(list: TreeNode[], node: TreeNode | null | undefined, seen: Set<string>): void {
  if (!node || seen.has(node.path)) {
    return;
  }
  seen.add(node.path);
  list.push(node);
}

// What a prop's declared type says one of these is made of. A component has
// no entry on the canvas to read real values from, so its own `interface
// Props` is the only description of its data there is — and a loop over
// `times?: ServiceTime[]` offered nothing at all without it.
function shapeChildren(field: SchemaField | undefined, base: string): TreeNode[] | null {
  if (!field?.shape?.length) {
    return null;
  }
  const shape = field.shape;
  const fields = (at: string): TreeNode[] =>
    shape.map((f) => ({
      path: `${at}.${f.name}`,
      key: f.name,
      kind: f.type === 'code' ? 'value' : f.type ?? 'value',
      preview: '',
      children: null,
    }));
  // A list is written the way a sample of one is, so everything downstream —
  // the loop item's fields, the picker's own walk — reads it the same way.
  return field.shapeIsList
    ? [{ path: `${base}[0]`, key: '0', kind: 'object', preview: '', children: fields(`${base}[0]`) }]
    : fields(base);
}

// 1. This file's own props. Real values when the canvas is showing an entry
//    that carries them; the declared type otherwise.
function buildPropNodes(
  destructures: readonly Destructure[],
  schema: readonly SchemaField[],
  sample: unknown,
  seen: Set<string>,
): TreeNode[] {
  const props: TreeNode[] = [];
  const sampleRecord = toRecord(sample);
  const known = (name: string): boolean =>
    sampleRecord !== undefined && Object.prototype.hasOwnProperty.call(sample, name);
  for (const d of destructures) {
    if (!/^Astro\.props\b/.test(d.from)) {
      continue;
    }
    if (known(d.name) && sampleRecord) {
      addUnique(props, sampleNode(d.name, d.name, sampleRecord[d.name], 0), seen);
      continue;
    }
    const field = schema.find((f) => f.name === d.name);
    const shape = shapeChildren(field, d.name);
    addUnique(props, {
      path: d.name,
      key: d.name,
      kind: shape && field?.shapeIsList
        ? 'list'
        : d.kind === 'rest'
          ? 'rest props'
          : field?.type || (d.kind || 'prop'),
      preview: field?.default !== undefined ? String(field.default) : '',
      children: shape,
    }, seen);
  }
  // A prop the file declares but destructures elsewhere (or reads off
  // Astro.props directly) is still a prop of this file.
  for (const f of schema) {
    if (seen.has(f.name)) {
      continue;
    }
    addUnique(
      props,
      known(f.name) && sampleRecord
        ? sampleNode(f.name, f.name, sampleRecord[f.name], 0)
        : {
            path: f.name,
            key: f.name,
            kind: f.shape && f.shapeIsList ? 'list' : f.type || 'prop',
            preview: f.default !== undefined ? String(f.default) : '',
            children: shapeChildren(f, f.name),
          },
      seen,
    );
  }
  return props;
}

// 2. The frontmatter's own values, and one level of any object literal.
function buildValueNodes(
  decls: ReadonlyMap<string, string>,
  destructures: readonly Destructure[],
  imports: readonly ImportLike[],
  samples: Record<string, unknown>,
  sample: unknown,
  seen: Set<string>,
): TreeNode[] {
  const values: TreeNode[] = [];
  for (const [name, value] of decls) {
    if (looksCallable(value)) {
      continue; // getStaticPaths and friends are code, not data
    }
    // A collection read by name gets the real thing: one entry, sampled, with
    // the query's own shape around it — `getCollection` hands back a list.
    const call = collectionCallIn(value);
    const entry = call ? samples[call.name] : null;
    if (call && entry) {
      const many = call.fn !== 'getEntry';
      const node = sampleNode(name, name, many ? [entry] : entry, 0);
      // "blog entries", not "1 item" — the sample is one of them, not all.
      node.preview = `${call.name} ${many ? 'entries' : 'entry'}`;
      addUnique(values, node, seen);
      continue;
    }
    // A reference followed through the data: `getEntry(post.data.author)` is
    // this post's author, so the fields shown are that author's.
    const ref = referenceCallIn(value);
    const at = ref ? sampleAt(sample, ref.path) : null;
    const targetList = toArray(at);
    const target = targetList
      ? targetList.find((v) => toRecord(v)?.['collection'])
      : at;
    const targetRecord = toRecord(target);
    const targetCollection = targetRecord?.['collection'];
    const targetId = targetRecord?.['id'];
    const resolved =
      typeof targetCollection === 'string'
        ? samples[sampleKey(targetCollection, typeof targetId === 'string' ? targetId : undefined)]
        : undefined;
    if (resolved && ref && typeof targetCollection === 'string') {
      const many = ref.fn === 'getEntries';
      const node = sampleNode(name, name, many ? [resolved] : resolved, 0);
      node.preview = `${targetCollection} ${many ? 'entries' : 'entry'}`;
      addUnique(values, node, seen);
      continue;
    }
    addUnique(values, literalNode(name, name, value, 0), seen);
  }
  for (const d of destructures) {
    if (/^Astro\.props\b/.test(d.from)) {
      continue;
    }
    const shape = /\brender\s*\(/.test(d.from) ? RENDER_SHAPE[d.name] : undefined;
    addUnique(
      values,
      shape
        ? shapeNode(d.name, shape)
        : { path: d.name, key: d.name, kind: d.kind || 'value', preview: '', children: null },
      seen,
    );
  }
  for (const imp of imports) {
    if (imp.name === undefined || decls.has(imp.name)) {
      continue;
    }
    if (!mayHoldData(imp)) {
      continue;
    }
    addUnique(values, { path: imp.name, key: imp.name, kind: 'import', preview: '', children: null }, seen);
  }
  return values;
}

// A value that is another value narrowed — `headings.filter(…)` — gets that
// value's fields. Done after everything else is in, so it doesn't matter
// which was declared first.
function applyDerivedShapes(decls: ReadonlyMap<string, string>, props: readonly TreeNode[], values: readonly TreeNode[]): void {
  const byName = new Map<string, TreeNode>();
  for (const n of props) {
    byName.set(n.path, n);
  }
  for (const n of values) {
    byName.set(n.path, n);
  }
  for (const [name, value] of decls) {
    const node = byName.get(name);
    if (!node || node.children) {
      continue;
    }
    const src = String(value).trim();
    const m = src.match(KEEPS_SHAPE);
    const baseName = m?.[1];
    const base = baseName !== undefined ? byName.get(baseName) : undefined;
    if (base?.children) {
      node.kind = base.kind;
      node.preview = base.preview;
      node.children = rebase(base.children, base.path, name);
      continue;
    }
    // One OF a list is one of whatever the list holds, so the fields to show
    // are the item's — `featured` opens onto the same fields as `portfolio`'s
    // first entry, because that is what it is.
    const one = src.match(PICKS_ONE);
    const oneName = one?.[1];
    const from = oneName !== undefined ? byName.get(oneName) : undefined;
    const item = from?.kind === 'list' && from.children?.length === 1 ? from.children[0] : null;
    if (!item?.children) {
      continue;
    }
    node.kind = item.kind;
    // "portfolio entries" describes the list; this is one of them.
    node.preview = /\bentries$/.test(from?.preview ?? '')
      ? (from?.preview ?? '').replace(/\bentries$/, 'entry')
      : item.preview || '';
    node.children = rebase(item.children, item.path, name);
  }
}

// 4. Every other collection in the project, whether or not this page reads
//    one. Data anywhere in the site is reachable from here: picking from one
//    of these writes the query that fetches it, and the path is then an
//    ordinary binding like any other.
function buildCollectionNodes(
  collections: readonly { readonly name: string; readonly count?: number }[],
  fm: string,
  imports: readonly ImportLike[],
  samples: Record<string, unknown>,
  seen: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const queried = queriesInScope(fm);
  const taken = namesInScope(fm, imports);
  for (const c of collections) {
    if (queried.has(c.name)) {
      continue; // already read here, so it is above
    }
    const identifier = autoQueryName(c.name, taken);
    taken.add(identifier);
    const entry = samples[c.name];
    const node: TreeNode = entry
      ? sampleNode(identifier, c.name, [entry], 0)
      : { path: identifier, key: c.name, kind: 'list', preview: '', children: null };
    node.key = c.name;
    node.preview = c.count === undefined ? 'collection' : `${c.count} entries`;
    node.section = 'collections';
    // What picking anything under this node has to write first.
    node.query = { collection: c.name, name: identifier };
    // Nothing fetched yet: the picker asks for it when this row is opened,
    // rather than the app loading every collection in the project up front.
    node.lazy = !entry;
    addUnique(out, node, seen);
  }
  return out;
}

// Every field any entry in a list has, each shown with a value from the entry
// being looked at — `at`, which the item's own arrows step — and from whichever
// other entry has it when that one doesn't. A field the first entry left out is
// still a field of the item; a value from another entry is better than a blank
// row; and which entry you are reading is a thing you can move.
function everyField(entries: readonly TreeNode[] | undefined, at = 0): TreeNode[] | null {
  const first = entries?.[0];
  if (!first) {
    return null;
  }
  const out: TreeNode[] = [];
  const seenKeys = new Set<string>();
  // The entry being read leads, in its own order, so stepping to it shows what
  // it holds rather than what the first one holds.
  const chosen = entries[at];
  const order = chosen !== undefined && at !== 0 ? [chosen, ...entries] : entries;
  for (const entry of order) {
    // Written as a field of the FIRST entry, whatever entry it came from —
    // the whole branch, not just its top: the tree is rebased onto the loop's
    // item name from there, and a path through `[3]` would name one particular
    // service rather than the item.
    const home = entries[at] ?? first;
    const kids = entry === home ? entry.children ?? [] : rebase(entry.children, entry.path, home.path) ?? [];
    for (const child of kids) {
      if (seenKeys.has(child.key)) {
        continue;
      }
      seenKeys.add(child.key);
      out.push(child);
    }
  }
  return out.length ? out : null;
}

// 3. Loop items, resolved against everything above: an enclosing
//    `posts.map((post) => …)` hands `post` one element of `posts`, so the
//    item shows that element's fields with its values.
function buildLoopNodes(
  ancestorHeads: readonly string[],
  props: readonly TreeNode[],
  values: readonly TreeNode[],
  itemIndex: Record<string, number> | undefined,
  seen: Set<string>,
): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const index = (list: readonly TreeNode[]): void => {
    for (const n of list) {
      byPath.set(n.path, n);
      if (n.children) {
        index(n.children);
      }
    }
  };
  index(props);
  index(values);

  // Innermost first: the loop you are standing in is the one whose item you
  // are most likely reaching for, and an outer loop is further away in every
  // sense.
  const loops: TreeNode[] = [];
  for (const head of [...ancestorHeads].reverse()) {
    const m = String(head).trim().match(MAP_HEAD_RE);
    const sourceName = m?.[1];
    const item = m?.[2];
    if (!m || sourceName === undefined || item === undefined) {
      continue;
    }
    const source = byPath.get(sourceName.trim());
    const first = source?.kind === 'list' ? source.children?.[0] : null;
    // Which entry of the list the item is being read as. One list, one place
    // in it — the arrows on the row move it (see `nav` below).
    const entries = source?.kind === 'list' ? source.children ?? [] : [];
    const at = Math.min(Math.max(itemIndex?.[item] ?? 0, 0), Math.max(entries.length - 1, 0));
    const shown = entries[at] ?? first;
    addUnique(loops, {
      path: item,
      key: item,
      kind: first ? first.kind : 'loop item',
      preview: shown ? shown.preview : '',
      // What the arrows on this row say, and what they have to step through.
      // Only when there is more than one entry to look at: a list of one, or a
      // shape with no values behind it at all, has nowhere to go.
      ...(entries.length > 1 ? { nav: { index: at, count: entries.length } } : {}),
      // Re-rooted onto the item's name: `posts[0].title` is `post.title` here.
      // Every entry contributes: a field the first one happens not to have — a
      // campus on one service and not another — is still a field of the item,
      // and leaving it out meant typing `service.campus` from memory to reach
      // a value the picker was already holding.
      children: shown ? rebase(everyField(entries, at), shown.path, item) : null,
    }, seen);
    const indexName = m[3];
    if (indexName !== undefined) {
      addUnique(loops, { path: indexName, key: indexName, kind: 'number', preview: '0', children: null }, seen);
    }
  }
  return loops;
}

/**
 * Everything in scope at the selection that a prop can be bound to, as a tree.
 *
 * context: {frontmatter, imports, ancestorHeads, propsSample, propsSchema}
 *   propsSample — the page's real Astro.props for the entry on the canvas,
 *                 from getStaticPaths (see page:dynamicPaths). Absent for a
 *                 static page or a component, where the shape is all there is.
 *   propsSchema — this file's own `interface Props`, so a component's props
 *                 still say what they are (`overlap` — boolean) without one.
 *   collectionSamples — {blog: <one sampled entry>}, so a page that lists a
 *                 collection shows what one of them holds.
 *
 * Ordered by what you are likeliest to want: this file's props, the item of
 * each enclosing loop, the frontmatter's own values, then imports.
 */
export function dataTree(context: DataContext | null | undefined): TreeNode[] {
  const fm = context?.frontmatter ?? '';
  const decls = parseDeclarations(fm);
  const destructures = parseDestructures(fm);
  const sample = context?.propsSample ?? null;
  const schema = context?.propsSchema ?? [];
  const samples = context?.collectionSamples ?? {};
  const imports = context?.imports ?? [];
  const seen = new Set<string>();

  const props = buildPropNodes(destructures, schema, sample, seen);
  const values = buildValueNodes(decls, destructures, imports, samples, sample, seen);
  applyDerivedShapes(decls, props, values);
  values.push(...buildCollectionNodes(context?.collections ?? [], fm, imports, samples, seen));
  const loops = buildLoopNodes(context?.ancestorHeads ?? [], props, values, context?.itemIndex, seen);

  // The loop item leads: inside a loop, it is what the markup is FOR — every
  // field in there is a field of that item. Then this file's props, then
  // everything else it holds.
  return [...loops, ...props, ...values];
}

// What can be looped over: a list, or a value whose shape the app cannot see
// and which may well be one (an import, a query result, a loop item). Text,
// numbers, dates and objects cannot.
const LOOPABLE = new Set(['list', 'value', 'import', 'loop item', 'prop', 'rest props']);

export interface PickableNode extends TreeNode {
  pickable: boolean;
}

/**
 * The tree with only the branches that lead somewhere loopable, for the loop
 * editor's Data field. Ancestors are kept so the list can be reached — you
 * navigate through `post` and `post.data` to get to `post.data.tags` — but
 * they are marked unpickable, because looping over an object is not a thing.
 */
export function listsOnly(nodes: readonly TreeNode[] | null | undefined): PickableNode[] {
  const out: PickableNode[] = [];
  for (const n of nodes ?? []) {
    const children = listsOnly(n.children);
    const pickable = LOOPABLE.has(n.kind);
    if (!pickable && !children.length) {
      continue;
    }
    out.push({ ...n, pickable, children: children.length ? children : null });
  }
  return out;
}

// `posts[0].data.title` seen from inside the loop is `post.data.title`.
function rebase(nodes: readonly TreeNode[] | null | undefined, from: string, to: string): TreeNode[] | null {
  if (!nodes) {
    return null;
  }
  return nodes.map((n) => ({
    ...n,
    path: to + n.path.slice(from.length),
    children: rebase(n.children, from, to),
  }));
}

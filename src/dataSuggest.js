// Heuristic static analysis powering the loop "Data" suggestions: top-level
// frontmatter declarations and imports, ancestor loop variables, and — by
// reading object literals — the keys nested inside them, so `service`
// suggests `service.tags` without executing any code.

function skipString(code, i) {
  const q = code[i];
  i++;
  while (i < code.length && code[i] !== q) {
    if (code[i] === '\\') i++;
    i++;
  }
  return i;
}

// End index (exclusive) of an expression starting at `start`: stops at a
// top-level ';' or a newline not continued by a chained operator.
function scanValue(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth < 0) return i;
    } else if (depth === 0 && ch === ';') return i;
    else if (depth === 0 && ch === '\n') {
      if (!/^\s*(\.|\)|\]|\}|,|\|\||&&|\?|:)/.test(code.slice(i))) return i;
    }
  }
  return code.length;
}

// Top-level const/let/var declarations: name -> value text.
export function parseDeclarations(code) {
  const out = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].length;
    const end = scanValue(code, start);
    out.set(m[1], code.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

// Locates one top-level declaration by name and reports where it sits, so a
// prop bound to `{rotatingWords}` can offer to edit the `const rotatingWords
// = […]` behind it. `start`/`end` bound the whole statement (its indentation
// stays outside the range, and a trailing ';' inside it).
export function findDeclaration(code, name) {
  const src = String(code || '');
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const re = new RegExp(
    `(?:^|\\n)([ \\t]*)((?:export\\s+)?(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\s*=\\s*)`,
    'g'
  );
  const m = re.exec(src);
  if (!m) return null;
  const valueStart = m.index + m[0].length;
  const start = valueStart - m[2].length;
  const valueEnd = scanValue(src, valueStart);
  const end = src[valueEnd] === ';' ? valueEnd + 1 : valueEnd;
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
export function findImportOf(code, name) {
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(code || ''))) !== null) {
    const clause = m[1];
    const spec = m[2];
    // `* as ns` and a default binding are the whole name; a braced list needs
    // its entries split, honouring `a as b` (the local name is what's used).
    const braced = clause.match(/\{([\s\S]*)\}/);
    const names = [];
    const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+/, '');
    for (const part of outside.split(',')) {
      const t = part.trim();
      if (t) names.push(t);
    }
    if (braced) {
      for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        names.push((as[1] || as[0]).trim());
      }
    }
    if (names.includes(ident)) return { name: ident, spec };
  }
  return null;
}

// The first '{…}' object inside an array literal (or the object itself).
export function firstObjectIn(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('{')) return t;
  if (!t.startsWith('[')) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i);
      continue;
    }
    if (ch === '{' && depth === 1) {
      let d = 0;
      for (let j = i; j < t.length; j++) {
        const c = t[j];
        if (c === '"' || c === "'" || c === '`') {
          j = skipString(t, j);
          continue;
        }
        if (c === '{') d++;
        else if (c === '}') {
          d--;
          if (d === 0) return t.slice(i, j + 1);
        }
      }
      return null;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
  }
  return null;
}

// Top-level entries of an object literal: [{key, value}]. Shorthand keys
// ({ name, url }) yield empty value text.
export function objectEntries(text) {
  if (!text) return [];
  const t = text.trim();
  if (!t.startsWith('{')) return [];
  const entries = [];
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
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
    if (depth === 1 && /[,{\s]/.test(t[i - 1] || '{')) {
      const m = t.slice(i).match(/^([\w$]+)\s*(:)?/);
      if (m && (m[2] || /^[\w$]+\s*[,}]/.test(t.slice(i)))) {
        if (!m[2]) {
          entries.push({ key: m[1], value: '' });
          i += m[1].length;
          continue;
        }
        const vs = i + m[0].length;
        let d = depth;
        let j = vs;
        while (j < t.length) {
          const c = t[j];
          if (c === '"' || c === "'" || c === '`') {
            j = skipString(t, j) + 1;
            continue;
          }
          if ('([{'.includes(c)) d++;
          else if (')]}'.includes(c)) {
            d--;
            if (d === 0) break;
          } else if (c === ',' && d === 1) break;
          j++;
        }
        entries.push({ key: m[1], value: t.slice(vs, j).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return entries;
}

function kindOf(value) {
  if (!value) return '';
  const t = value.trim();
  if (t.startsWith('[')) return 'list';
  if (t.startsWith('{')) return 'object';
  if (/^['"`]/.test(t)) return 'text';
  if (/^-?\d/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'boolean';
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

function mayHoldData(imp) {
  const path = String(imp?.path || '');
  if (NON_DATA_EXT.test(path) || TOOL_MODULE.test(path)) return false;
  return !/^[A-Z]/.test(String(imp?.name || ''));
}

// Follow a dotted path (['services'] or ['service','tags']) through value
// texts; stepping into an array uses its first object's shape.
function resolvePath(rootValue, parts) {
  let cur = rootValue;
  for (const part of parts) {
    const obj = cur && cur.trim().startsWith('[') ? firstObjectIn(cur) : cur;
    const entry = objectEntries(obj || '').find((e) => e.key === part);
    if (!entry) return null;
    cur = entry.value;
  }
  return cur;
}

// Splits `a, b = {x: 1}, ...rest` on its top-level commas — a destructuring
// pattern's parts, with nested objects, arrays and strings left alone.
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// First `ch` at the top level of `text`, or -1 — the `:` of a rename and the
// `=` of a default, without tripping over either inside a default value.
function topIndexOf(text, ch) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
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
export function parseDestructures(code) {
  const src = String(code || '');
  const out = [];
  const re = /(?:^|[\n;])\s*(?:export\s+)?(?:const|let|var)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = re.lastIndex - 1;
    // The pattern's own closing brace, then the `=` that must follow it —
    // without which this is a block, not a declaration.
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        i = skipString(src, i);
        continue;
      }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) break;
    re.lastIndex = close + 1;
    const eq = src.slice(close + 1).match(/^\s*=\s*/);
    if (!eq) continue;
    const valueStart = close + 1 + eq[0].length;
    const from = src.slice(valueStart, scanValue(src, valueStart)).trim();
    for (const part of splitTopLevel(src.slice(open + 1, close))) {
      const t = part.trim();
      if (!t) continue;
      if (t.startsWith('...')) {
        const rest = t.slice(3).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(rest)) out.push({ name: rest, from, kind: 'rest' });
        continue;
      }
      const colon = topIndexOf(t, ':');
      let local = colon === -1 ? t : t.slice(colon + 1);
      const eqAt = topIndexOf(local, '=');
      const def = eqAt === -1 ? '' : local.slice(eqAt + 1).trim();
      local = (eqAt === -1 ? local : local.slice(0, eqAt)).trim();
      // A nested pattern (`{ data: { title } }`) binds names one level down —
      // this reads the flat cases, and skips what it can't name.
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
      out.push({ name: local, from, kind: kindOf(def) });
    }
  }
  return out;
}

// A declaration holding a function rather than data — `export const
// getStaticPaths = (async () => {…})`. Offering it as something to bind to is
// noise, and every page has one.
function looksCallable(value) {
  const raw = String(value || '').trim();
  const test = (t) =>
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

export function collectionCallIn(text) {
  const m = String(text || '').match(COLLECTION_CALL);
  return m ? { fn: m[1], name: m[2] } : null;
}

// `getEntry(post.data.author)` — a reference, which names no collection in the
// line itself. What it points AT does: an Astro reference value is
// {id, collection}, so the answer is in the data the editor already has.
const REF_CALL = /\b(getEntry|getEntries)\s*\(\s*([\w$]+(?:\.[\w$]+)*(?:\[\d+\])?)\s*\)/;

export function referenceCallIn(text) {
  const m = String(text || '').match(REF_CALL);
  return m ? { fn: m[1], path: m[2] } : null;
}

/** The value at a dotted path inside sampled data: `post.data.author` → {id, collection}. */
export function sampleAt(sample, path) {
  let cur = sample;
  for (const step of String(path || '').split('.')) {
    const m = step.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (m[1]) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[m[1]];
    }
    for (const idx of m[2].match(/\d+/g) || []) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

// What an Astro reference looks like once it is data: the entry it points to,
// named by collection and id, with nothing loaded yet.
const isRef = (v) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof v.id === 'string' &&
  typeof v.collection === 'string' &&
  v.data === undefined;

/** How a fetched entry is keyed. One per collection+id, so refs to the same entry share. */
export const sampleKey = (collection, id) => (id ? `${collection}#${id}` : collection);

/**
 * The entries this file resolves by reference — `const author = await
 * getEntry(post.data.author)` — as {key, collection, id} to fetch. Needs the
 * props sample, since the reference's target is in the data, not the source.
 */
export function referencesInScope(frontmatter, propsSample) {
  if (!propsSample) return [];
  const out = [];
  const seen = new Set();
  const consider = (valueText) => {
    const call = referenceCallIn(valueText);
    if (!call) return;
    const at = sampleAt(propsSample, call.path);
    const ref = Array.isArray(at) ? at.find(isRef) : at;
    if (!isRef(ref)) return;
    const key = sampleKey(ref.collection, ref.id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, collection: ref.collection, id: ref.id });
  };
  for (const [, value] of parseDeclarations(frontmatter || '')) consider(value);
  for (const d of parseDestructures(frontmatter || '')) consider(d.from);
  return out;
}

// ---------------------------------------------------------------------------
// Sampled data, as something to show: what a value IS, and what is inside it.
// ---------------------------------------------------------------------------

// The markers the dev-server sampler leaves behind for what JSON can't hold.
// See PATHS_ENDPOINT in electron/main.js.
const marker = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.__stacki : null);

export function sampleKind(v) {
  if (v === null || v === undefined) return 'empty';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return marker(v) || 'object';
  if (typeof v === 'string') return 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
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
const isEntry = (v) => v && typeof v === 'object' && 'collection' in v && 'data' in v;
const shownKeys = (v) =>
  isEntry(v) ? Object.keys(v).filter((k) => !ENTRY_INTERNALS.has(k)) : Object.keys(v);

const clip = (text, max) =>
  String(text).length > max ? `${String(text).slice(0, max)}…` : String(text);

// One line saying what a value IS — the thing a designer reads down the right
// of the picker to find the field they mean. A container says how much is in
// it rather than showing a wall of JSON; that's what expanding it is for.
export function samplePreview(v) {
  const kind = sampleKind(v);
  if (kind === 'date') return v.value ? String(v.value).slice(0, 10) : 'date';
  if (kind === 'deep') return 'deeper…';
  if (kind === 'more') return `${v.count} more`;
  if (kind === 'empty') return '—';
  if (kind === 'text') return v === '' ? '""' : clip(`"${v}"`, 42);
  if (kind === 'number' || kind === 'boolean') return String(v);
  if (kind === 'list') {
    const more = v.find((x) => marker(x) === 'more');
    const shown = v.length - (more ? 1 : 0);
    const total = more ? shown + more.count : shown;
    return `${total} ${total === 1 ? 'item' : 'items'}`;
  }
  const keys = shownKeys(v);
  return keys.length ? `${keys.length} ${keys.length === 1 ? 'field' : 'fields'}` : '{}';
}

const MAX_TREE_DEPTH = 6;

// A value the app has actually seen — every key is real, so the tree is the
// data rather than a guess at it.
function fromSample(value, base, depth) {
  if (depth >= MAX_TREE_DEPTH) return null;
  const kind = sampleKind(value);
  if (kind === 'object') {
    return shownKeys(value).map((k) => sampleNode(`${base}.${k}`, k, value[k], depth + 1));
  }
  if (kind === 'list') {
    return value
      .map((v, i) =>
        marker(v) === 'more' ? null : sampleNode(`${base}[${i}]`, String(i), v, depth + 1)
      )
      .filter(Boolean);
  }
  return null;
}

function sampleNode(path, key, value, depth) {
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
function fromLiteral(text, base, depth) {
  if (depth >= MAX_LITERAL_DEPTH) return null;
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    const entries = objectEntries(t);
    return entries.length
      ? entries.map((e) => literalNode(`${base}.${e.key}`, e.key, e.value, depth + 1))
      : null;
  }
  if (t.startsWith('[')) {
    const first = firstObjectIn(t);
    if (!first) return null;
    const item = literalNode(`${base}[0]`, '0', first, depth + 1);
    return item.children ? [item] : null;
  }
  return null;
}

function literalNode(path, key, valueText, depth) {
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

/** Those queries, as {name, start, end} spans in the frontmatter text. */
export function markedQueries(frontmatter) {
  const out = [];
  const re = new RegExp(
    `^[ \\t]*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^\\n]*?//\\s*${QUERY_MARK}[ \\t]*$`,
    'gm'
  );
  let m;
  while ((m = re.exec(frontmatter || '')) !== null) {
    out.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The frontmatter without one of them — the line and the break that carried
 * it, so taking a query back leaves the file exactly as it was before the
 * query was added, rather than a blank line where it used to be.
 */
export function removeMarkedQuery(frontmatter, name) {
  const found = markedQueries(frontmatter).find((q) => q.name === name);
  if (!found) return frontmatter;
  const src = String(frontmatter);
  let { start, end } = found;
  if (start > 0 && src[start - 1] === '\n') start -= 1;
  else if (src[end] === '\n') end += 1;
  return src.slice(0, start) + src.slice(end);
}

/**
 * The collection queries this file already has: collection name → the
 * identifier holding it. What makes picking from a collection twice reuse the
 * first query instead of writing a second one for the same content.
 */
export function queriesInScope(frontmatter) {
  const out = new Map();
  for (const [name, value] of parseDeclarations(frontmatter || '')) {
    // `export const getStaticPaths = async () => { … getCollection("blog") … }`
    // mentions a collection without holding one. Binding to it would name a
    // function where a list was meant.
    if (looksCallable(value)) continue;
    const call = collectionCallIn(value);
    if (call?.fn === 'getCollection' && !out.has(call.name)) out.set(call.name, name);
  }
  return out;
}

/** Every name the frontmatter already binds — what an auto-named query must avoid. */
export function namesInScope(frontmatter, imports) {
  const taken = new Set();
  for (const [name] of parseDeclarations(frontmatter || '')) taken.add(name);
  for (const d of parseDestructures(frontmatter || '')) taken.add(d.name);
  for (const i of imports || []) taken.add(i.name);
  return taken;
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
export function scopeCompletions(context = {}) {
  const out = [];
  const seen = new Set();
  const add = (label, detail) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    out.push({ label, detail });
  };
  const walk = (nodes, depth) => {
    for (const node of nodes || []) {
      add(node.path, node.preview ? String(node.preview).slice(0, 40) : node.section || '');
      // One level in is the useful depth: `post.data` earns its place, every
      // field of every collection does not — the picker is for browsing.
      if (depth < 2 && Array.isArray(node.children)) walk(node.children, depth + 1);
    }
  };
  try {
    walk(dataTree(context), 0);
  } catch {
    /* a half-written frontmatter parses to nothing; the names below still do */
  }
  for (const name of namesInScope(context.frontmatter || '', context.imports || [])) {
    add(name, 'frontmatter');
  }
  return out;
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
export function scopeChips(text, names) {
  const src = String(text ?? '');
  const inScope = names instanceof Set ? names : new Set(names || []);
  if (!inScope.size) return [];
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Skip over a string whole — quotes, escapes and all.
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
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
    while (j < src.length && /[\w$]/.test(src[j])) j += 1;
    while (src[j] === '.' && /[A-Za-z_$]/.test(src[j + 1] || '')) {
      j += 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
    }
    let path = src.slice(i, j);
    let end = j;
    // A call is the method, not the value: in `items.map(…)` the value is
    // `items`, so the chip stops before `.map`. `fn(…)` on its own chips nothing.
    if (src.slice(j).trimStart().startsWith('(')) {
      const cut = path.lastIndexOf('.');
      if (cut <= 0) { i = j; continue; }
      end = i + cut;
      path = path.slice(0, cut);
    }
    // Not a property of something else — the `data` in `post.data` is part of
    // that chip, not one of its own.
    const before = src.slice(0, i).trimEnd();
    if (!before.endsWith('.') && inScope.has(path.split('.')[0])) {
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
export function autoQueryName(collection, taken = new Set()) {
  const camel = String(collection)
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]+/, '');
  const base = `${camel || 'collection'}Entries`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}X`;
}

/** Which collections this file reads by name — what the app fetches a sample entry for. */
export function collectionsInScope(frontmatter) {
  const out = new Set();
  for (const [, value] of parseDeclarations(frontmatter)) {
    const c = collectionCallIn(value);
    if (c) out.add(c.name);
  }
  for (const d of parseDestructures(frontmatter)) {
    const c = collectionCallIn(d.from);
    if (c) out.add(c.name);
  }
  return [...out];
}

// `const { Content, headings } = await render(post)` — made while the page
// renders, so there is nothing to sample. The shape is Astro's own and fixed,
// and the field names are the point: a table of contents is built out of
// heading.depth and heading.slug. Names and types only; no invented values.
const RENDER_SHAPE = {
  headings: [
    { key: 'depth', kind: 'number' },
    { key: 'slug', kind: 'text' },
    { key: 'text', kind: 'text' },
  ],
};

function shapeNode(name, fields) {
  const item = {
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
export function dataTree(context) {
  const fm = context?.frontmatter || '';
  const decls = parseDeclarations(fm);
  const destructures = parseDestructures(fm);
  const sample = context?.propsSample || null;
  const schema = context?.propsSchema || [];
  const props = [];
  const values = [];
  const seen = new Set();

  const add = (list, node) => {
    if (!node || seen.has(node.path)) return;
    seen.add(node.path);
    list.push(node);
  };

  // 1. This file's own props. Real values when the canvas is showing an entry
  //    that carries them; the declared type otherwise.
  for (const d of destructures) {
    if (!/^Astro\.props\b/.test(d.from)) continue;
    const known = sample && Object.prototype.hasOwnProperty.call(sample, d.name);
    if (known) {
      add(props, sampleNode(d.name, d.name, sample[d.name], 0));
      continue;
    }
    const field = schema.find((f) => f.name === d.name);
    add(props, {
      path: d.name,
      key: d.name,
      kind: d.kind === 'rest' ? 'rest props' : field?.type || d.kind || 'prop',
      preview: field?.default !== undefined ? String(field.default) : '',
      children: null,
    });
  }
  // A prop the file declares but destructures elsewhere (or reads off
  // Astro.props directly) is still a prop of this file.
  for (const f of schema) {
    if (seen.has(f.name)) continue;
    const known = sample && Object.prototype.hasOwnProperty.call(sample, f.name);
    add(
      props,
      known
        ? sampleNode(f.name, f.name, sample[f.name], 0)
        : {
            path: f.name,
            key: f.name,
            kind: f.type || 'prop',
            preview: f.default !== undefined ? String(f.default) : '',
            children: null,
          }
    );
  }

  // 2. The frontmatter's own values, and one level of any object literal.
  const samples = context?.collectionSamples || {};
  for (const [name, value] of decls) {
    if (looksCallable(value)) continue; // getStaticPaths and friends are code, not data
    // A collection read by name gets the real thing: one entry, sampled, with
    // the query's own shape around it — `getCollection` hands back a list.
    const call = collectionCallIn(value);
    const entry = call ? samples[call.name] : null;
    if (entry) {
      const many = call.fn !== 'getEntry';
      const node = sampleNode(name, name, many ? [entry] : entry, 0);
      // "blog entries", not "1 item" — the sample is one of them, not all.
      node.preview = `${call.name} ${many ? 'entries' : 'entry'}`;
      add(values, node);
      continue;
    }
    // A reference followed through the data: `getEntry(post.data.author)` is
    // this post's author, so the fields shown are that author's.
    const ref = referenceCallIn(value);
    const at = ref ? sampleAt(sample, ref.path) : null;
    const target = Array.isArray(at) ? at.find((v) => v && v.collection) : at;
    const resolved = target && samples[sampleKey(target.collection, target.id)];
    if (resolved) {
      const many = ref.fn === 'getEntries';
      const node = sampleNode(name, name, many ? [resolved] : resolved, 0);
      node.preview = `${target.collection} ${many ? 'entries' : 'entry'}`;
      add(values, node);
      continue;
    }
    add(values, literalNode(name, name, value, 0));
  }
  for (const d of destructures) {
    if (/^Astro\.props\b/.test(d.from)) continue;
    const shape = /\brender\s*\(/.test(d.from) ? RENDER_SHAPE[d.name] : null;
    add(
      values,
      shape
        ? shapeNode(d.name, shape)
        : { path: d.name, key: d.name, kind: d.kind || 'value', preview: '', children: null }
    );
  }
  for (const imp of context?.imports || []) {
    if (decls.has(imp.name)) continue;
    if (!mayHoldData(imp)) continue;
    add(values, { path: imp.name, key: imp.name, kind: 'import', preview: '', children: null });
  }

  // A value that is another value narrowed — `headings.filter(…)` — gets that
  // value's fields. Done after everything else is in, so it doesn't matter
  // which was declared first.
  const byName = new Map();
  const indexNames = (list) => {
    for (const n of list) byName.set(n.path, n);
  };
  indexNames(props);
  indexNames(values);
  for (const [name, value] of decls) {
    const node = byName.get(name);
    if (!node || node.children) continue;
    const src = String(value).trim();
    const m = src.match(KEEPS_SHAPE);
    const base = m && byName.get(m[1]);
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
    const from = one && byName.get(one[1]);
    const item = from?.kind === 'list' && from.children?.length === 1 ? from.children[0] : null;
    if (!item?.children) continue;
    node.kind = item.kind;
    // "portfolio entries" describes the list; this is one of them.
    node.preview = /\bentries$/.test(from.preview || '')
      ? from.preview.replace(/\bentries$/, 'entry')
      : item.preview || '';
    node.children = rebase(item.children, item.path, name);
  }

  // 4. Every other collection in the project, whether or not this page reads
  //    one. Data anywhere in the site is reachable from here: picking from one
  //    of these writes the query that fetches it, and the path is then an
  //    ordinary binding like any other.
  const queried = queriesInScope(fm);
  const taken = namesInScope(fm, context?.imports);
  for (const c of context?.collections || []) {
    if (queried.has(c.name)) continue; // already read here, so it is above
    const identifier = autoQueryName(c.name, taken);
    taken.add(identifier);
    const entry = samples[c.name];
    const node = entry
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
    add(values, node);
  }

  // 3. Loop items, resolved against everything above: an enclosing
  //    `posts.map((post) => …)` hands `post` one element of `posts`, so the
  //    item shows that element's fields with its values.
  const byPath = new Map();
  const index = (list) => {
    for (const n of list) {
      byPath.set(n.path, n);
      if (n.children) index(n.children);
    }
  };
  index(props);
  index(values);

  // Innermost first: the loop you are standing in is the one whose item you
  // are most likely reaching for, and an outer loop is further away in every
  // sense.
  const loops = [];
  for (const head of [...(context?.ancestorHeads || [])].reverse()) {
    const m = String(head).trim().match(MAP_HEAD_RE);
    if (!m) continue;
    const item = m[2];
    const source = byPath.get(m[1].trim());
    const first = source?.kind === 'list' ? source.children?.[0] : null;
    add(loops, {
      path: item,
      key: item,
      kind: first ? first.kind : 'loop item',
      preview: first ? first.preview : '',
      // Re-rooted onto the item's name: `posts[0].title` is `post.title` here.
      children: first ? rebase(first.children, first.path, item) : null,
    });
    if (m[3]) add(loops, { path: m[3], key: m[3], kind: 'number', preview: '0', children: null });
  }

  // The loop item leads: inside a loop, it is what the markup is FOR — every
  // field in there is a field of that item. Then this file's props, then
  // everything else it holds.
  return [...loops, ...props, ...values];
}

// What can be looped over: a list, or a value whose shape the app cannot see
// and which may well be one (an import, a query result, a loop item). Text,
// numbers, dates and objects cannot.
const LOOPABLE = new Set(['list', 'value', 'import', 'loop item', 'prop', 'rest props']);

/**
 * The tree with only the branches that lead somewhere loopable, for the loop
 * editor's Data field. Ancestors are kept so the list can be reached — you
 * navigate through `post` and `post.data` to get to `post.data.tags` — but
 * they are marked unpickable, because looping over an object is not a thing.
 */
export function listsOnly(nodes) {
  const out = [];
  for (const n of nodes || []) {
    const children = listsOnly(n.children);
    const pickable = LOOPABLE.has(n.kind);
    if (!pickable && !children.length) continue;
    out.push({ ...n, pickable, children: children.length ? children : null });
  }
  return out;
}

// `posts[0].data.title` seen from inside the loop is `post.data.title`.
function rebase(nodes, from, to) {
  if (!nodes) return null;
  return nodes.map((n) => ({
    ...n,
    path: to + n.path.slice(from.length),
    children: rebase(n.children, from, to),
  }));
}


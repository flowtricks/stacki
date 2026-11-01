// Reading data out of frontmatter source: declarations, imports, object
// literals, destructures and collection calls, scanned without a parser
// (dataSuggest.ts).

export const DATA_SUGGEST_LIMITS = {
  // One level in is the useful depth for completions: `post.data` earns its place, every
  // field of every collection does not — the picker is for browsing.
  completionDepthMax: 2,
} as const;

// The index of the closing quote of the string that opens at `start`, or the end of the code.
export function skipString(code: string, start: number): number {
  const quote = code.charAt(start);
  let index = start + 1;
  while (index < code.length && code.charAt(index) !== quote) {
    if (code.charAt(index) === '\\') {
      index++;
    }
    index++;
  }
  return index;
}

// End index (exclusive) of an expression starting at `start`: stops at a
// top-level ';' or a newline not continued by a chained operator.
export function scanValue(code: string, start: number): number {
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
  let match;
  while ((match = re.exec(code)) !== null) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    const start = match.index + match[0].length;
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
export function findDeclaration(code: unknown, name: unknown): DeclarationSpan | undefined {
  const source = String(code || '');
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return undefined;
  }
  const re = new RegExp(`(?:^|\\n)([ \\t]*)((?:export\\s+)?(?:const|let|var)\\s+` + `${ident.replace(/\$/g, '\\$')}\\s*=\\s*)`, 'g');
  const match = re.exec(source);
  const lead = match?.[1];
  const head = match?.[2];
  if (!match || lead === undefined || head === undefined) {
    return undefined;
  }
  const valueStart = match.index + match[0].length;
  const start = valueStart - head.length;
  const valueEnd = scanValue(source, valueStart);
  const end = source.charAt(valueEnd) === ';' ? valueEnd + 1 : valueEnd;
  return {
    name: ident,
    start,
    end,
    statement: source.slice(start, end),
    value: source.slice(valueStart, valueEnd).trim(),
  };
}

/**
 * The import that brings `name` into a file, as {name, spec}, or undefined.
 * Covers `import x from`, `import { a, b as c } from`, `import * as ns from`
 * and type-only imports — everything a page's frontmatter can carry.
 */
export function findImportOf(code: unknown, name: unknown): { name: string; spec: string } | undefined {
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return undefined;
  }
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(String(code || ''))) !== null) {
    const clause = match[1];
    const spec = match[2];
    if (clause === undefined || spec === undefined) {
      continue;
    }
    // `* as ns` and a default binding are the whole name; a braced list needs
    // its entries split, honouring `a as b` (the local name is what's used).
    const braced = clause.match(/\{([\s\S]*)\}/);
    const names: string[] = [];
    const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+/, '');
    for (const part of outside.split(',')) {
      const entry = part.trim();
      if (entry) {
        names.push(entry);
      }
    }
    const bracedBody = braced?.[1];
    if (bracedBody !== undefined) {
      for (const part of bracedBody.split(',')) {
        const entry = part.trim();
        if (!entry) {
          continue;
        }
        const as = entry.split(/\s+as\s+/);
        names.push((as[1] || as[0] || '').trim());
      }
    }
    if (names.includes(ident)) {
      return { name: ident, spec };
    }
  }
  return undefined;
}

// The first '{…}' object inside an array literal (or the object itself).
export function firstObjectIn(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  if (!trimmed.startsWith('[')) {
    return undefined;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(trimmed, i);
      continue;
    }
    if (ch === '{' && depth === 1) {
      let nesting = 0;
      for (let j = i; j < trimmed.length; j++) {
        const character = trimmed.charAt(j);
        if (character === '"' || character === "'" || character === '`') {
          j = skipString(trimmed, j);
          continue;
        }
        if (character === '{') {
          nesting++;
        } else if (character === '}') {
          nesting--;
          if (nesting === 0) {
            return trimmed.slice(i, j + 1);
          }
        }
      }
      return undefined;
    }
    if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
    }
  }
  return undefined;
}

export interface ObjectEntry {
  readonly key: string;
  readonly value: string;
}

// Top-level entries of an object literal: [{key, value}]. Shorthand keys
// ({ name, url }) yield empty value text.
export function objectEntries(text: string | undefined): ObjectEntry[] {
  if (!text) {
    return [];
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return [];
  }
  const pairs: ObjectEntry[] = [];
  let depth = 0;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(trimmed, i) + 1;
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
    if (depth === 1 && /[,{\s]/.test(trimmed.charAt(i - 1) || '{')) {
      const match = trimmed.slice(i).match(/^([\w$]+)\s*(:)?/);
      const key = match?.[1];
      if (match && key !== undefined && (match[2] || /^[\w$]+\s*[,}]/.test(trimmed.slice(i)))) {
        if (!match[2]) {
          pairs.push({ key, value: '' });
          i += key.length;
          continue;
        }
        const vs = i + match[0].length;
        let nesting = depth;
        let j = vs;
        while (j < trimmed.length) {
          const character = trimmed.charAt(j);
          if (character === '"' || character === "'" || character === '`') {
            j = skipString(trimmed, j) + 1;
            continue;
          }
          if ('([{'.includes(character)) {
            nesting++;
          } else if (')]}'.includes(character)) {
            nesting--;
            if (nesting === 0) {
              break;
            }
          } else if (character === ',' && nesting === 1) {
            break;
          }
          j++;
        }
        pairs.push({ key, value: trimmed.slice(vs, j).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return pairs;
}

export function kindOf(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    return 'list';
  }
  if (trimmed.startsWith('{')) {
    return 'object';
  }
  if (/^['"`]/.test(trimmed)) {
    return 'text';
  }
  if (/^-?\d/.test(trimmed)) {
    return 'number';
  }
  if (/^(true|false)$/.test(trimmed)) {
    return 'boolean';
  }
  return '';
}

// Modules that can't be looped over, by what they are rather than by naming
// luck: markup, styles, and media. A PascalCase default import is Astro's
// component convention, which catches the rest.
export const NON_DATA_EXT = new RegExp('\\.(astro|md|mdx|css|s[ac]ss|less|svg|png|jpe?g|gif|webp|avif|ico|bmp|' + 'mp4|webm|mov|woff2?|ttf|otf)(\\?.*)?$', 'i');

// The framework's own modules hold functions and types — `getCollection`,
// `render`, `GetStaticPaths`. They are how data is FETCHED, never data itself,
// and every content page imports four of them, so unfiltered they crowd out
// the values underneath.
export const TOOL_MODULE = /^(astro(:|$)|node:)/;

export interface ImportLike {
  readonly name?: string;
  readonly path?: string;
}

export function mayHoldData(imp: ImportLike | undefined): boolean {
  const path = String(imp?.path || '');
  if (NON_DATA_EXT.test(path) || TOOL_MODULE.test(path)) {
    return false;
  }
  return !/^[A-Z]/.test(String(imp?.name || ''));
}

// Splits `a, b = {x: 1}, ...rest` on its top-level commas — a destructuring
// pattern's parts, with nested objects, arrays and strings left alone.
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (character === '"' || character === "'" || character === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// First `ch` at the top level of `text`, or -1 — the `:` of a rename and the
// `=` of a default, without tripping over either inside a default value.
export function topIndexOf(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (character === '"' || character === "'" || character === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ch && depth === 0) {
      return i;
    }
  }
  return -1;
}

export interface Destructure {
  /** The local name the code reads it by. */
  readonly name: string;
  /** The property it is read from: `filters` in `{ filters: propFilters }`, else the name. */
  readonly prop: string;
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
  const source = String(code || '');
  const out: Destructure[] = [];
  const re = /(?:^|[\n;])\s*(?:export\s+)?(?:const|let|var)\s*\{/g;
  while (re.exec(source) !== null) {
    const open = re.lastIndex - 1;
    // The pattern's own closing brace, then the `=` that must follow it —
    // without which this is a block, not a declaration.
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      const character = source.charAt(i);
      if (character === '"' || character === "'" || character === '`') {
        i = skipString(source, i);
        continue;
      }
      if ('([{'.includes(character)) {
        depth++;
      } else if (')]}'.includes(character)) {
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
    const eq = source.slice(close + 1).match(/^\s*=\s*/);
    if (!eq) {
      continue;
    }
    const valueStart = close + 1 + eq[0].length;
    const from = source.slice(valueStart, scanValue(source, valueStart)).trim();
    for (const part of splitTopLevel(source.slice(open + 1, close))) {
      const entry = part.trim();
      if (!entry) {
        continue;
      }
      if (entry.startsWith('...')) {
        const rest = entry.slice(3).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(rest)) {
          out.push({ name: rest, prop: rest, from, kind: 'rest' });
        }
        continue;
      }
      const colon = topIndexOf(entry, ':');
      let local = colon === -1 ? entry : entry.slice(colon + 1);
      const eqAt = topIndexOf(local, '=');
      const defaultText = eqAt === -1 ? '' : local.slice(eqAt + 1).trim();
      local = (eqAt === -1 ? local : local.slice(0, eqAt)).trim();
      // A nested pattern (`{ data: { title } }`) binds names one level down —
      // this reads the flat cases, and skips what it can't name.
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) {
        continue;
      }
      const key = colon === -1 ? local : entry.slice(0, colon).trim();
      out.push({ name: local, prop: /^[A-Za-z_$][\w$]*$/.test(key) ? key : local, from, kind: kindOf(defaultText) });
    }
  }
  return out;
}

// A declaration holding a function rather than data — `export const
// getStaticPaths = (async () => {…})`. Offering it as something to bind to is
// noise, and every page has one.
export function looksCallable(value: unknown): boolean {
  const raw = String(value || '').trim();
  const test = (candidate: string): boolean =>
    /^(async\s+)?function\b/.test(candidate) || /^(async\s*)?\([^()]*\)\s*(:[^=]*)?=>/.test(candidate) || /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(candidate);
  // Both as written and with an opening paren dropped: `(href) => …` is an
  // arrow, and so is the `(async () => {…}) satisfies GetStaticPaths` that
  // wraps one.
  return test(raw) || test(raw.replace(/^\(\s*/, ''));
}

// `await getCollection("blog")`, `getEntry("author", id)` — the collection a
// declaration reads, when it names one outright.
export const COLLECTION_CALL = /\b(getCollection|getEntry|getEntries)\s*\(\s*['"]([\w-]+)['"]/;

export function collectionCallIn(text: unknown): { fn: string; name: string } | undefined {
  const match = String(text || '').match(COLLECTION_CALL);
  const callee = match?.[1];
  const name = match?.[2];
  return callee !== undefined && name !== undefined ? { fn: callee, name } : undefined;
}

// `getEntry(post.data.author)` — a reference, which names no collection in the
// line itself. What it points AT does: an Astro reference value is
// {id, collection}, so the answer is in the data the editor already has.
export const REF_CALL = /\b(getEntry|getEntries)\s*\(\s*([\w$]+(?:\.[\w$]+)*(?:\[\d+\])?)\s*\)/;

export function referenceCallIn(text: unknown): { fn: string; path: string } | undefined {
  const match = String(text || '').match(REF_CALL);
  const callee = match?.[1];
  const path = match?.[2];
  return callee !== undefined && path !== undefined ? { fn: callee, path } : undefined;
}

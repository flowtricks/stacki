// What is in scope in a page's frontmatter: marked queries, the names a
// binding can use, and the chips a code field draws (dataSuggest.ts).

import {
  parseDeclarations,
  type ImportLike,
  parseDestructures,
  looksCallable,
  collectionCallIn,
} from './dataSource';

// Numbered names tried for a collection's entries before settling on `…X`: a
// page reads a handful of collections, never dozens under one name.
export const COLLECTION_NAME_ATTEMPTS_MAX = 50;

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
export function markedQueries(frontmatter: string | undefined): MarkedQuery[] {
  const out: MarkedQuery[] = [];
  const re = new RegExp(
    `^[ \\t]*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^\\n]*?//\\s*${QUERY_MARK}[ \\t]*$`,
    'gm',
  );
  let match;
  while ((match = re.exec(frontmatter ?? '')) !== null) {
    const name = match[1];
    if (name !== undefined) {
      out.push({ name, start: match.index, end: match.index + match[0].length });
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
  const found = markedQueries(frontmatter).find((query) => query.name === name);
  if (!found) {
    return frontmatter;
  }
  const source = String(frontmatter);
  let { start, end } = found;
  if (start > 0 && source.charAt(start - 1) === '\n') {
    start -= 1;
  } else if (source.charAt(end) === '\n') {
    end += 1;
  }
  return source.slice(0, start) + source.slice(end);
}

/**
 * The collection queries this file already has: collection name → the
 * identifier holding it. What makes picking from a collection twice reuse the
 * first query instead of writing a second one for the same content.
 */
export function queriesInScope(frontmatter: string | undefined): Map<string, string> {
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
  frontmatter: string | undefined,
  imports: readonly ImportLike[] | undefined,
): Set<string> {
  const taken = new Set<string>();
  for (const [name] of parseDeclarations(frontmatter ?? '')) {
    taken.add(name);
  }
  for (const destructure of parseDestructures(frontmatter ?? '')) {
    taken.add(destructure.name);
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
  /**
   * What a value the file computes by calling an import returned, sampled by
   * the dev server — `campusPastors` for `await getCampusPastors()`. Keyed by
   * the value's name.
   */
  readonly valueSamples?: Record<string, unknown>;
}

export interface SchemaField {
  readonly name: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly shape?: readonly { readonly name: string; readonly type?: string }[];
  readonly shapeIsList?: boolean;
}

export interface ScopeChip {
  readonly from: number;
  readonly to: number;
  readonly path: string;
}

export const TYPE_OPERATORS = new Set(['as', 'satisfies']);

export function isTypeSyntaxIdentifier(source: string, from: number, root: string): boolean {
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
export function scopeChips(
  text: unknown,
  names: Iterable<string> | Set<string> | undefined,
): ScopeChip[] {
  const source = String(text ?? '');
  const inScope = names instanceof Set ? names : new Set(names ?? []);
  if (!inScope.size) {
    return [];
  }
  const out: ScopeChip[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    // Skip over a string whole — quotes, escapes and all.
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < source.length && source.charAt(i) !== ch) {
        i += source.charAt(i) === '\\' ? 2 : 1;
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
    while (j < source.length && /[\w$]/.test(source.charAt(j))) {
      j += 1;
    }
    while (source.charAt(j) === '.' && /[A-Za-z_$]/.test(source.charAt(j + 1))) {
      j += 1;
      while (j < source.length && /[\w$]/.test(source.charAt(j))) {
        j += 1;
      }
    }
    let path = source.slice(i, j);
    let end = j;
    // A call is the method, not the value: in `items.map(…)` the value is
    // `items`, so the chip stops before `.map`. `fn(…)` on its own chips nothing.
    if (source.slice(j).trimStart().startsWith('(')) {
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
    const before = source.slice(0, i).trimEnd();
    const root = path.split('.')[0] ?? '';
    if (!before.endsWith('.') && inScope.has(root) && !isTypeSyntaxIdentifier(source, i, root)) {
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
    .replace(/[^A-Za-z0-9]+(.)?/g, (_whole: string, letter?: string) =>
      letter ? letter.toUpperCase() : '',
    )
    .replace(/^[0-9]+/, '');
  const base = `${camel || 'collection'}Entries`;
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; i < COLLECTION_NAME_ATTEMPTS_MAX; i++) {
    if (!taken.has(`${base}${i}`)) {
      return `${base}${i}`;
    }
  }
  return `${base}X`;
}

/** A frontmatter value the file gets by calling one of its imports, with no arguments. */
export interface ImportedCall {
  /** The value's name: `campusPastors`. */
  readonly name: string;
  /** The imported function: `getCampusPastors`. */
  readonly exportName: string;
  /** Where it is imported from, as the file writes it: `@/sanity/queries.ts`. */
  readonly spec: string;
}

// `await getCampusPastors()` exactly: one imported name, called with nothing.
// Anything with arguments depends on values the app cannot supply, so it is
// left as an unknown value rather than run with the wrong ones.
const IMPORTED_CALL = /^await\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?$/;

/**
 * The values this file computes by calling an import — what the app asks the
 * dev server to sample, since only it can run the project's code.
 */
export function importedCallsInScope(
  frontmatter: string | undefined,
  imports: readonly ImportLike[],
): ImportedCall[] {
  const calls: ImportedCall[] = [];
  for (const [name, value] of parseDeclarations(frontmatter ?? '')) {
    const exportName = IMPORTED_CALL.exec(value.trim())?.[1];
    const spec = imports.find(
      (entry) => entry.name !== undefined && entry.name === exportName,
    )?.path;
    if (exportName !== undefined && spec !== undefined) {
      calls.push({ name, exportName, spec });
    }
  }
  return calls;
}

/** Which collections this file reads by name — what the app fetches a sample entry for. */
export function collectionsInScope(frontmatter: string | undefined): string[] {
  const out = new Set<string>();
  for (const [, value] of parseDeclarations(frontmatter ?? '')) {
    const call = collectionCallIn(value);
    if (call) {
      out.add(call.name);
    }
  }
  for (const destructure of parseDestructures(frontmatter ?? '')) {
    const call = collectionCallIn(destructure.from);
    if (call) {
      out.add(call.name);
    }
  }
  return [...out];
}

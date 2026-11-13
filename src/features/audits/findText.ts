// Find and replace across the site, as pure functions: where a query matches in
// one file's tree (text, attribute values, and code only when asked), what a
// value reads after replacing, and the fix plan that writes the replacement
// through the same edit path as the audit's fixes. Content entries (CMS data)
// are searched value by value with the same matcher.
import { assert } from '../../../shared/core/assert';
import type { AuditEdit, AuditFinding } from '../../../shared/page/auditFindings';
import type { PageNode } from '../../../shared/page/pageNode';
import { isInternalAttribute } from '../../../shared/core/internalAttributes';
import { LIMITS } from '../../../shared/core/limits';

export interface FindOptions {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  /** Expressions, scripts and style blocks too; frontmatter is searched but never rewritten. */
  readonly includeCode: boolean;
}

export type MatchPlace = { readonly kind: 'text' } | { readonly kind: 'attribute'; readonly name: string; readonly tag: string } | { readonly kind: 'code' };

export interface TextMatch {
  readonly path: readonly number[];
  readonly place: MatchPlace;
  /** The whole value the match is in, and how many times the query occurs in it. */
  readonly value: string;
  readonly count: number;
}

/** Matches one search may list before it stops: a site-wide search for "a" must still answer. */
export const MATCHES_MAX = 2_000;
const NODES_MAX = 20_000;

/** The query as a pattern, or undefined for an empty query. */
export function findPattern(options: Pick<FindOptions, 'query' | 'caseSensitive' | 'wholeWord'>): RegExp | undefined {
  if (options.query.length === 0) {
    return undefined;
  }
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, `gu${options.caseSensitive ? '' : 'i'}`);
}

/** How many times `pattern` occurs in `value`. */
export function countIn(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

/** `value` with every match replaced; the replacement is literal text, never a pattern. */
export function replacedIn(value: string, pattern: RegExp, replacement: string): string {
  const next = value.replace(pattern, () => replacement);
  assert(typeof next === 'string', 'replacedIn: a string');
  return next;
}

/** Every match in one file's tree, in document order. */
export function findInTree(nodes: readonly PageNode[], options: FindOptions): readonly TextMatch[] {
  const pattern = findPattern(options);
  if (pattern === undefined) {
    return [];
  }
  const found: TextMatch[] = [];
  const pending: { readonly node: PageNode; readonly path: readonly number[] }[] = nodes.map((node, index) => ({ node, path: [index] })).reverse();
  for (let visited = 0; pending.length > 0 && found.length < MATCHES_MAX; visited++) {
    assert(visited < NODES_MAX, 'findInTree: a file stays inside the tree bound');
    const entry = pending.pop();
    assert(entry !== undefined, 'findInTree: the stack holds an entry');
    found.push(...ownMatches(entry.node, entry.path, pattern, options));
    if ('children' in entry.node && Array.isArray(entry.node.children)) {
      const children: readonly PageNode[] = entry.node.children;
      pending.push(...children.map((child, index) => ({ node: child, path: [...entry.path, index] })).reverse());
    }
  }
  return found;
}

function ownMatches(node: PageNode, path: readonly number[], pattern: RegExp, options: FindOptions): readonly TextMatch[] {
  switch (node.kind) {
    case 'text': {
      const count = countIn(node.value, pattern);
      return count === 0 ? [] : [{ path, place: { kind: 'text' }, value: node.value, count }];
    }
    case 'expr': {
      const count = options.includeCode ? countIn(node.value, pattern) : 0;
      return count === 0 ? [] : [{ path, place: { kind: 'code' }, value: node.value, count }];
    }
    case 'raw': {
      const count = options.includeCode ? countIn(node.inner, pattern) : 0;
      return count === 0 ? [] : [{ path, place: { kind: 'code' }, value: node.inner, count }];
    }
    case 'element':
    case 'component':
      return Object.entries(node.props ?? {}).flatMap(([name, value]) => {
        if (value.type !== 'string' || isInternalAttribute(name)) {
          return [];
        }
        const count = countIn(value.value, pattern);
        return count === 0 ? [] : [{ path, place: { kind: 'attribute', name, tag: node.name }, value: value.value, count }];
      });
    case 'map':
    case 'raw-line':
    case 'comment':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return [];
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

/** The replacement as a fix plan, so it is written by the audit's edit path; undefined where only code matched. */
export function replacementFinding(file: string, match: TextMatch, pattern: RegExp, replacement: string): AuditFinding | undefined {
  const after = replacedIn(match.value, pattern, replacement);
  let edit: AuditEdit;
  switch (match.place.kind) {
    case 'text':
      edit = { tag: 'text', path: match.path, before: match.value, value: after };
      break;
    case 'attribute':
      edit = { tag: 'attributes', path: match.path, expect: match.place.tag, patch: { [match.place.name]: { type: 'string', value: after } } };
      break;
    case 'code':
      return undefined; // Code is found, not rewritten: a rename in code is the code editor's.
    default: {
      const exhaustive: never = match.place;
      return exhaustive;
    }
  }
  return {
    id: `replace|${file}|${match.path.join('.')}|${match.place.kind === 'attribute' ? match.place.name : 'text'}`,
    check: 'placeholder-text',
    file,
    fileKind: 'page',
    element: undefined,
    detail: after,
    source: 'static',
    // i18n-ignore: the fix label is an identity for the undo step; the Find panel draws its own translated buttons.
    fix: { label: 'Replace', before: match.value, after, file, edits: [edit] },
  };
}

/** Every string in a content entry's data that matches, by its key path; nested data is searched to a bound. */
export function findInData(
  data: unknown,
  pattern: RegExp,
): readonly { readonly keys: readonly (string | number)[]; readonly value: string; readonly count: number }[] {
  const found: { keys: readonly (string | number)[]; value: string; count: number }[] = [];
  const pending: { readonly value: unknown; readonly keys: readonly (string | number)[] }[] = [{ value: data, keys: [] }];
  for (let visited = 0; pending.length > 0 && found.length < MATCHES_MAX && visited < NODES_MAX; visited++) {
    const entry = pending.pop();
    assert(entry !== undefined, 'findInData: the stack holds an entry');
    if (typeof entry.value === 'string') {
      const count = countIn(entry.value, pattern);
      if (count > 0) {
        found.push({ keys: entry.keys, value: entry.value, count });
      }
    } else if (Array.isArray(entry.value)) {
      const list: readonly unknown[] = entry.value;
      list.forEach((item, index) => pending.push({ value: item, keys: [...entry.keys, index] }));
    } else if (typeof entry.value === 'object' && entry.value !== undefined && entry.value !== null) {
      for (const [key, item] of Object.entries(entry.value)) {
        pending.push({ value: item, keys: [...entry.keys, key] });
      }
    }
  }
  return found;
}

/** `data` with every matching string replaced, built anew; the original is untouched. */
export function replacedInData(data: unknown, pattern: RegExp, replacement: string, depth = 0): unknown {
  assert(depth <= LIMITS.ipcDepthMax, 'replacedInData: content data stays inside the depth bound');
  if (typeof data === 'string') {
    return replacedIn(data, pattern, replacement);
  }
  if (Array.isArray(data)) {
    const list: readonly unknown[] = data;
    return list.map((item) => replacedInData(item, pattern, replacement, depth + 1));
  }
  if (typeof data === 'object' && data !== undefined && data !== null) {
    return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, replacedInData(item, pattern, replacement, depth + 1)]));
  }
  return data;
}

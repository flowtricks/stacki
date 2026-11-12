// Sample data as the pickers show it: a value at a path, its kind and a short
// preview, the references it needs loaded, and the tree of its fields
// (dataSuggest.ts).

import { toRecord, toArray } from '../../shared/core/record';
import { parseDeclarations, firstObjectIn, objectEntries, kindOf, parseDestructures, referenceCallIn } from './dataSource';

/** One step of a data path, and where in the path's text it ends. */
export interface PathStep {
  readonly key: string | number;
  readonly end: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// `.name`, `[0]`, or `["name"]` (a field a dot can't reach: `campus-description`).
const STEP = /^(?:\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/;

/** A data path's steps: `post.data["campus-name"][0]` → post, data, campus-name, 0. */
export function pathSteps(path: string): readonly PathStep[] | undefined {
  const steps: PathStep[] = [];
  let at = 0;
  // Each step consumes at least one character, so the text's length bounds the loop.
  while (at < path.length) {
    const match = STEP.exec(path.slice(at));
    if (match === null || (steps.length === 0 && path.charAt(at) === '.')) {
      return undefined;
    }
    at += match[0].length;
    const quoted: unknown = match[3] === undefined ? undefined : JSON.parse(match[3]);
    const key = match[1] ?? (match[2] === undefined ? (typeof quoted === 'string' ? quoted : undefined) : Number(match[2]));
    if (key === undefined) {
      return undefined;
    }
    steps.push({ key, end: at });
  }
  return steps;
}

/** A field's path under its parent's: `.title`, or `["campus-name"]` when a dot can't reach it. */
export function childPath(base: string, key: string): string {
  return IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** The value at a path inside sampled data: `post.data.author` → {id, collection}. */
export function sampleAt(sample: unknown, path: unknown): unknown {
  const steps = pathSteps(String(path || ''));
  if (steps === undefined) {
    return undefined;
  }
  let current: unknown = sample;
  for (const step of steps) {
    if (typeof step.key === 'number') {
      current = toArray(current)?.[step.key];
    } else {
      current = toRecord(current)?.[step.key];
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

// What an Astro reference looks like once it is data: the entry it points to,
// named by collection and id, with nothing loaded yet.
export const isRef = (candidate: unknown): candidate is { id: string; collection: string } => {
  const record = toRecord(candidate);
  return record !== undefined && typeof record['id'] === 'string' && typeof record['collection'] === 'string' && record['data'] === undefined;
};

/** How a fetched entry is keyed. One per collection+id, so refs to the same entry share. */
export const sampleKey = (collection: string, id?: string): string => (id ? `${collection}#${id}` : collection);

/**
 * How the entry at a position in a collection is keyed: `stats[2]`, written as
 * the page's code would index it. A collection name is a bare word (the data
 * route refuses anything else), so this never collides with `sampleKey`.
 */
export const entrySampleKey = (collection: string, index: number): string => `${collection}[${index}]`;

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
export function referencesInScope(frontmatter: string | undefined, propsSample: unknown): ReferenceNeed[] {
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
  for (const destructure of parseDestructures(frontmatter ?? '')) {
    consider(destructure.from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sampled data, as something to show: what a value IS, and what is inside it.
// ---------------------------------------------------------------------------

// The markers the dev-server sampler leaves behind for what JSON can't hold.
// See PATHS_ENDPOINT in electron/preview/markerConfig.ts.
export const marker = (value: unknown): string | undefined => {
  const tag = toRecord(value)?.['__stacki'];
  return typeof tag === 'string' ? tag : undefined;
};

export function sampleKind(sample: unknown): string {
  // A sampled JSON `null` is data the dev server sent; it reads as empty.
  if (sample === null || sample === undefined) {
    return 'empty';
  }
  if (Array.isArray(sample)) {
    return 'list';
  }
  if (typeof sample === 'object') {
    return marker(sample) ?? 'object';
  }
  if (typeof sample === 'string') {
    return 'text';
  }
  if (typeof sample === 'number') {
    return 'number';
  }
  if (typeof sample === 'boolean') {
    return 'boolean';
  }
  return 'empty';
}

// Bookkeeping Astro puts on a content entry: where the file is, what its hash
// is, the rendered HTML. Real keys, and never what anyone means to bind — they
// would sit at the top of every entry, above the fields that matter.
export const ENTRY_INTERNALS = new Set(['filePath', 'digest', 'rendered', 'deferredRender', 'legacyId', 'assetImports']);
export const isEntry = (entry: Record<string, unknown>): boolean => 'collection' in entry && 'data' in entry;
export const shownKeys = (sample: unknown): string[] => {
  const record = toRecord(sample) ?? {};
  return isEntry(record) ? Object.keys(record).filter((key) => !ENTRY_INTERNALS.has(key)) : Object.keys(record);
};

export const clip = (text: unknown, max: number): string => (String(text).length > max ? `${String(text).slice(0, max)}…` : String(text));

// One line saying what a value IS — the thing a designer reads down the right
// of the picker to find the field they mean. A container says how much is in
// it rather than showing a wall of JSON; that's what expanding it is for.
export function samplePreview(sample: unknown): string {
  const kind = sampleKind(sample);
  if (kind === 'date') {
    const value = toRecord(sample)?.['value'];
    return value ? String(value).slice(0, 10) : 'date';
  }
  if (kind === 'deep') {
    return 'deeper…';
  }
  if (kind === 'more') {
    return `${String(toRecord(sample)?.['count'])} more`;
  }
  if (kind === 'empty') {
    return '—';
  }
  if (kind === 'text') {
    return sample === '' ? '""' : clip(`"${String(sample)}"`, 42);
  }
  if (kind === 'number' || kind === 'boolean') {
    return String(sample);
  }
  if (kind === 'list') {
    const list = toArray(sample) ?? [];
    const more = list.find((x) => marker(x) === 'more');
    const shown = list.length - (more ? 1 : 0);
    const count = toRecord(more)?.['count'];
    const total = more ? shown + (typeof count === 'number' ? count : 0) : shown;
    return `${total} ${total === 1 ? 'item' : 'items'}`;
  }
  const keys = shownKeys(sample);
  return keys.length ? `${keys.length} ${keys.length === 1 ? 'field' : 'fields'}` : '{}';
}

export const TREE_DEPTH_MAX = 6;

/**
 * An import a pick writes before its path means anything: `exported` from the
 * module `spec`, read here as `name` (`import { SITE } from '@/consts'`). A
 * JSON file's data is its `default` export.
 */
export interface ImportNeed {
  readonly spec: string;
  readonly exported: string;
  readonly name: string;
}

export interface TreeNode {
  path: string;
  key: string;
  kind: string;
  preview: string;
  children: TreeNode[] | undefined;
  section?: string;
  nav?: { index: number; count: number };
  /**
   * A list whose children are its entries (`[0]`, `[1]`, …): how many there
   * are, so the picker can show one at a time behind a pager rather than a
   * column of numbers. Counts the entries the picker can reach — a sampled
   * list's sampled ones, or a project collection's real total.
   */
  entryCount?: number;
  query?: { collection: string; name: string };
  /**
   * What picking anything under this node has to import first: an export of
   * a project data file the file does not import yet (projectDataSources.ts).
   */
  importNeed?: ImportNeed;
  /**
   * Why this row cannot be bound, when it cannot: an imported function is
   * something to call, and a binding to it would print the function itself.
   */
  unbindable?: string;
  /** A muted word in the value column where there is no value to show: "not set". */
  note?: string;
  /**
   * A data file export written as a list but computed (`[...a, ...b]`): it is a list,
   * and its items are known only to the code. The loop's Source menu lists it, disabled.
   */
  computedList?: boolean;
  lazy?: boolean;
  /** The whole address of an image the value names: the preview is clipped. */
  image?: string;
}

// A web address that names an image by its extension, or Sanity's image CDN.
const IMAGE_URL = /^https:\/\/(?:cdn\.sanity\.io\/images\/\S+|\S+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]\S*)?)$/i;

// A value the app has actually seen — every key is real, so the tree is the
// data rather than a guess at it.
export function fromSample(value: unknown, base: string, depth: number): TreeNode[] | undefined {
  if (depth >= TREE_DEPTH_MAX) {
    return undefined;
  }
  const kind = sampleKind(value);
  if (kind === 'object') {
    const record = toRecord(value) ?? {};
    return shownKeys(value).map((key) => sampleNode(childPath(base, key), key, record[key], depth + 1));
  }
  if (kind === 'list') {
    return (toArray(value) ?? [])
      .map((entry, i) => (marker(entry) === 'more' ? undefined : sampleNode(`${base}[${i}]`, String(i), entry, depth + 1)))
      .filter((node): node is TreeNode => node !== undefined);
  }
  return undefined;
}

export function sampleNode(path: string, key: string, value: unknown, depth: number): TreeNode {
  const children = fromSample(value, path, depth);
  const image = typeof value === 'string' && IMAGE_URL.test(value) ? value : undefined;
  const kind = sampleKind(value);
  const entryCount = kind === 'list' ? entryCountOf(children) : undefined;
  return {
    path,
    key,
    kind,
    preview: samplePreview(value),
    children: children && children.length ? children : undefined,
    ...(image === undefined ? {} : { image }),
    ...(entryCount === undefined ? {} : { entryCount }),
  };
}

// A list of records is a list of entries, browsed one at a time; a list of
// words or numbers reads best as it is, every value in a column.
function entryCountOf(children: readonly TreeNode[] | undefined): number | undefined {
  if (children === undefined) {
    return undefined;
  }
  if (children.length < 2) {
    return undefined;
  }
  return children.every((child) => child.children !== undefined) ? children.length : undefined;
}

export const LITERAL_DEPTH_MAX = 4;

// No live data, but the source says the shape outright: `const site = { … }`.
// A list contributes its FIRST item, which is the only one whose shape is
// knowable — and the one a loop over it will be handed.
export function fromLiteral(text: unknown, base: string, depth: number): TreeNode[] | undefined {
  if (depth >= LITERAL_DEPTH_MAX) {
    return undefined;
  }
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) {
    const entries = objectEntries(trimmed);
    return entries.length ? entries.map((entry) => literalNode(childPath(base, entry.key), entry.key, entry.value, depth + 1)) : undefined;
  }
  if (trimmed.startsWith('[')) {
    const first = firstObjectIn(trimmed);
    if (!first) {
      return undefined;
    }
    const item = literalNode(`${base}[0]`, '0', first, depth + 1);
    return item.children ? [item] : undefined;
  }
  return undefined;
}

export function literalNode(path: string, key: string, valueText: unknown, depth: number): TreeNode {
  const trimmed = String(valueText || '').trim();
  const kind = kindOf(trimmed) || 'value';
  const children = fromLiteral(trimmed, path, depth);
  return {
    path,
    key,
    kind,
    // A literal IS its value, so it shows it. Anything else is an expression
    // — `await getEntry(post.data.author)` — and putting that in the value
    // column is showing a designer the code the picker exists to avoid.
    preview: kind === 'text' || kind === 'number' || kind === 'boolean' ? clip(trimmed, 42) : '',
    children: children && children.length ? children : undefined,
  };
}

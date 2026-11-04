// The order of the style context dropdown (Base, then queries).
//
// The dropdown is where a query is chosen to write into, so the queries most
// likely to be wanted come first: Base always leads; then the queries the
// selected element itself has styles in (the ones with the dot); then the
// queries its nearest relatives have styles in, closest relative first; then
// everything else, in the order the list already had. Each group keeps that
// order too, so the list only moves rows between groups, never shuffles one.
//
// Relatives are found without asking the canvas. The page tree the host holds
// gives the parent chain and the children, and the classes each node writes;
// the parsed rules give, per query, the classes of each selector's subject. A
// relative "has styles" in a query when a rule there has a subject whose every
// class is one the relative writes. That ignores tags, attributes and
// combinators, so it can over-count (`.card .title` counts for any `.title`),
// and it misses classes set by an expression. Both are fine for a hint that
// only orders a list: the exact answer would cost a canvas round trip per
// selection for a row's position, while this costs one walk of a bounded tree.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import { compileSelectorList } from './selectorParse';
import { propText, walkNodes, type HostNode } from './host';

export const CONTEXT_ORDER_LIMITS = {
  /** Rows the dropdown can order. A project has a few dozen queries at most. */
  contextsMax: 1_024,
  /** Ancestors asked, closest first. Beyond a few levels a query is no hint. */
  relativeAncestorsMax: 8,
  /** Levels of children asked below the element. */
  relativeDescendantDepthMax: 3,
  /** Descendants asked, nearest level first, so a long list stays cheap. */
  relativeDescendantsMax: 48,
  /** Subject entries the class index keeps across every stylesheet. */
  indexEntriesMax: 20_000,
} as const satisfies Record<string, number>;

/** A rule as the index reads it: where it sits, what it selects, whether it styles. */
export type IndexedRule = {
  readonly atContext: readonly string[];
  readonly selectors: ReadonlyArray<{ readonly text: string }>;
  readonly declarations: readonly unknown[];
};

/** One selector subject inside a query: its classes and the dropdown key of that query. */
export type QueryIndexEntry = {
  readonly classes: readonly string[];
  readonly contextKey: string;
};

/** Subject entries, filed under each of their classes. */
export type QueryIndex = ReadonlyMap<string, readonly QueryIndexEntry[]>;

/** A node near the selected one: the classes it writes and how many steps away it is. */
export type Relative = {
  readonly classes: readonly string[];
  readonly distance: number;
};

/**
 * The dropdown rows in order: Base, then the element's own styled queries, then
 * the relatives' (in `relatives` order), then the rest. Every group keeps the
 * order `contexts` had, and no row appears twice.
 */
export function orderContexts<T extends { readonly key: string }>(contexts: readonly T[], own: ReadonlySet<string>, relatives: readonly string[]): T[] {
  assert(contexts.length <= CONTEXT_ORDER_LIMITS.contextsMax, 'orderContexts: more contexts than the limit');
  assert(relatives.length <= CONTEXT_ORDER_LIMITS.contextsMax, 'orderContexts: more relative contexts than the limit');
  const relativeRank = new Map<string, number>();
  relatives.forEach((key, rank) => {
    if (!relativeRank.has(key)) {
      relativeRank.set(key, rank);
    }
  });
  const base: T[] = [];
  const owned: T[] = [];
  const related: Array<{ readonly context: T; readonly rank: number }> = [];
  const rest: T[] = [];
  const seen = new Set<string>();
  for (const context of contexts) {
    if (seen.has(context.key)) {
      continue;
    }
    seen.add(context.key);
    const rank = relativeRank.get(context.key);
    if (context.key === '') {
      base.push(context);
    } else if (own.has(context.key)) {
      owned.push(context);
    } else if (rank === undefined) {
      rest.push(context);
    } else {
      related.push({ context, rank });
    }
  }
  // Array.prototype.sort is stable, so equal ranks keep the order they came in.
  related.sort((left, right) => left.rank - right.rank);
  const ordered = [...base, ...owned, ...related.map((entry) => entry.context), ...rest];
  assert(ordered.length === seen.size, 'orderContexts: every row is placed once');
  assert(base.length <= 1, 'orderContexts: one Base row');
  return ordered;
}

/**
 * File every styling rule inside a query under its subject's classes. `keyOf`
 * turns an at-context (`@media (width < 50rem)`) into the dropdown's key for it,
 * which for a breakpoint is not the query text.
 */
export function indexQueriesByClass(rules: readonly IndexedRule[], keyOf: (atContext: string) => string): QueryIndex {
  const index = new Map<string, QueryIndexEntry[]>();
  let entryCount = 0;
  for (const rule of rules) {
    if (rule.atContext.length === 0) {
      continue;
    }
    if (rule.declarations.length === 0) {
      continue;
    }
    const contextKey = keyOf(rule.atContext.join(' › '));
    for (const selector of rule.selectors) {
      for (const compiled of compileSelectorList(selector.text)) {
        const subject = compiled.compounds[compiled.compounds.length - 1];
        if (subject === undefined || subject.classes.length === 0) {
          continue;
        }
        if (entryCount < CONTEXT_ORDER_LIMITS.indexEntriesMax) {
          entryCount += 1;
          fileEntry(index, { classes: [...subject.classes], contextKey });
        } else {
          // A hint, not a contract: past the limit the rest of the sheet just
          // doesn't move rows.
          return index;
        }
      }
    }
  }
  assert(entryCount <= CONTEXT_ORDER_LIMITS.indexEntriesMax, 'indexQueriesByClass: entries within the limit');
  return index;
}

/**
 * The selected node's relatives that write classes, nearest first: ancestors
 * outwards and descendants downwards, an ancestor before a descendant at the
 * same distance. Bounded by CONTEXT_ORDER_LIMITS.
 */
export function relativesOf(nodes: readonly HostNode[], selectedId: string | undefined): Relative[] {
  if (selectedId === undefined) {
    return [];
  }
  const parents = new Map<string, HostNode>();
  let selected: HostNode | undefined;
  walkNodes(nodes, (node, parent) => {
    if (node.id === selectedId) {
      selected = node;
    }
    if (parent !== undefined) {
      parents.set(node.id, parent);
    }
  });
  if (selected === undefined) {
    return [];
  }
  const ancestors = ancestorsOf(parents, selectedId);
  const descendants = descendantsOf(selected);
  const relatives = [...ancestors, ...descendants].filter((relative) => relative.classes.length > 0);
  // Stable: ancestors were listed first, so they win a tie in distance.
  relatives.sort((left, right) => left.distance - right.distance);
  assert(ancestors.length <= CONTEXT_ORDER_LIMITS.relativeAncestorsMax, 'relativesOf: ancestors within the limit');
  assert(descendants.length <= CONTEXT_ORDER_LIMITS.relativeDescendantsMax, 'relativesOf: descendants within the limit');
  return relatives;
}

/** The dropdown keys the relatives have styles in, nearest relative first, each once. */
export function relativeContexts(relatives: readonly Relative[], index: QueryIndex): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const relative of relatives) {
    const classes = new Set(relative.classes);
    for (const name of classes) {
      for (const entry of index.get(name) ?? []) {
        if (seen.has(entry.contextKey)) {
          continue;
        }
        if (entry.classes.every((entryClass) => classes.has(entryClass))) {
          seen.add(entry.contextKey);
          keys.push(entry.contextKey);
        }
      }
    }
  }
  assert(keys.length === seen.size, 'relativeContexts: each key once');
  return keys;
}

function fileEntry(index: Map<string, QueryIndexEntry[]>, entry: QueryIndexEntry): void {
  for (const name of new Set(entry.classes)) {
    const list = index.get(name);
    if (list === undefined) {
      index.set(name, [entry]);
    } else {
      list.push(entry);
    }
  }
}

function classesOf(node: HostNode): string[] {
  return propText(node, 'class').trim().split(/\s+/).filter(Boolean);
}

function ancestorsOf(parents: ReadonlyMap<string, HostNode>, selectedId: string): Relative[] {
  const ancestors: Relative[] = [];
  let current = parents.get(selectedId);
  for (let distance = 1; current !== undefined && distance <= CONTEXT_ORDER_LIMITS.relativeAncestorsMax; distance++) {
    ancestors.push({ classes: classesOf(current), distance });
    current = parents.get(current.id);
  }
  return ancestors;
}

// Breadth-first, so the nearest level is asked first and the count limit cuts
// the farthest children, not a whole branch of near ones.
function descendantsOf(selected: HostNode): Relative[] {
  assert(CONTEXT_ORDER_LIMITS.relativeDescendantDepthMax <= LIMITS.treeDepthMax, 'descendantsOf: depth within the tree limit');
  const descendants: Relative[] = [];
  let level: readonly HostNode[] = selected.children ?? [];
  for (let distance = 1; distance <= CONTEXT_ORDER_LIMITS.relativeDescendantDepthMax; distance++) {
    const next: HostNode[] = [];
    for (const node of level) {
      if (descendants.length < CONTEXT_ORDER_LIMITS.relativeDescendantsMax) {
        descendants.push({ classes: classesOf(node), distance });
        next.push(...(node.children ?? []));
      } else {
        return descendants;
      }
    }
    level = next;
  }
  return descendants;
}

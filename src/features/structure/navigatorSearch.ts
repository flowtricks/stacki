// The Navigator's search as values: which rows of the page tree a query keeps, by element or
// component name, tag, class, id and text, each kept row with the rows above it.
//
// Pure. The panel builds the index once per tree (each node's name, class, id and words folded to
// lowercase without accents, one string per node) and every keystroke is then one linear walk over
// the tree with `String.includes`. The result is a copy of the tree holding only the matches and
// their ancestors; the panel draws that copy fully open (a closed ancestor would hide a match), so
// what the person folded or unfolded is never touched and returns when the search clears.
//
// A copy of the tree has different child positions than the page, and a drop lands at a position,
// so the panel never draws the copy while anything is being dragged (StructurePanel.tsx).
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { foldSearchText, holdsEveryWord, queryWords } from '../../lib/searchText';
import type { NavigatorNode } from './structureModel';

/**
 * Rows that match on their own, at most. A page of tens of thousands of nodes searched for `d` would
 * otherwise draw a row for nearly every one of them; past this the later matches are left out and the
 * panel says so. The Navigator is not windowed, so the bound is on rows drawn.
 */
export const NAVIGATOR_MATCHES_MAX = 500;

/** Each node's folded search text, by node id. */
export type NavigatorSearchIndex = ReadonlyMap<string, string>;

export interface NavigatorSearchResult {
  /** The matching rows and their ancestors, in page order. */
  readonly nodes: readonly NavigatorNode[];
  /** Rows that matched on their own, never more than NAVIGATOR_MATCHES_MAX. */
  readonly matchCount: number;
  /** True when more rows matched than the bound lets through. */
  readonly capped: boolean;
}

/** The index of a tree: one walk, folding each node's text once. */
export function buildNavigatorIndex(nodes: readonly NavigatorNode[]): NavigatorSearchIndex {
  const index = new Map<string, string>();
  const stack: { readonly node: NavigatorNode; readonly depth: number }[] = nodes.map((node) => ({ node, depth: 0 }));
  // Every pass pops one node and pushes its children, so the walk visits each node once.
  for (let step = 0; step < LIMITS.treeNodesMax && stack.length > 0; step += 1) {
    const entry = stack.pop();
    assert(entry !== undefined, 'The stack had a node');
    assert(entry.depth <= LIMITS.treeDepthMax, 'The Navigator index walks no deeper than a page tree');
    index.set(entry.node.id, foldSearchText(nodeText(entry.node)));
    for (const child of childrenOf(entry.node)) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  assert(stack.length === 0, 'The index walk visited every node');
  return index;
}

/**
 * The tree reduced to the rows that hold every word of the query, and their ancestors. A query with
 * no word keeps nothing: the panel draws the page instead of searching.
 */
export function searchNavigator(nodes: readonly NavigatorNode[], index: NavigatorSearchIndex, query: string): NavigatorSearchResult {
  const words = queryWords(query);
  const budget = new MatchBudget();
  if (words.length === 0) {
    return { nodes: [], matchCount: 0, capped: false };
  }
  const kept = keepAll(nodes, { index, words, budget }, 0);
  assert(budget.matches <= NAVIGATOR_MATCHES_MAX, 'Matches stay within the bound');
  return { nodes: kept, matchCount: budget.matches, capped: budget.capped };
}

interface Walk {
  readonly index: NavigatorSearchIndex;
  readonly words: readonly string[];
  readonly budget: MatchBudget;
}

// The count of rows that matched on their own. A class, so the walk's parameter is never assigned to:
// the walk asks the budget to take a match and the budget owns its own counters.
class MatchBudget {
  matches = 0;
  capped = false;

  /** Spends one match; false, and the walk is marked capped, when none is left. */
  take(): boolean {
    if (this.matches >= NAVIGATOR_MATCHES_MAX) {
      this.capped = true;
      return false;
    }
    this.matches += 1;
    return true;
  }
}

function keepAll(nodes: readonly NavigatorNode[], walk: Walk, depth: number): readonly NavigatorNode[] {
  // Depth is a page tree's, which the parser bounds; the assertion makes the recursion's limit stated.
  assert(depth <= LIMITS.treeDepthMax, 'The Navigator search walks no deeper than a page tree');
  const kept: NavigatorNode[] = [];
  for (const node of nodes) {
    const keptNode = keepNode(node, walk, depth);
    if (keptNode !== undefined) {
      kept.push(keptNode);
    }
  }
  return kept;
}

function keepNode(node: NavigatorNode, walk: Walk, depth: number): NavigatorNode | undefined {
  // The recursion's limit, stated: a page tree is never deeper than this (a cond's branch is one level down).
  assert(depth <= LIMITS.treeDepthMax, 'The Navigator search walks no deeper than a page tree');
  const own = matchesOwn(node, walk);
  switch (node.kind) {
    case 'component':
    case 'element': {
      const children = node.children === undefined ? [] : keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'map': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'chunk-group': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'branch': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'cond': {
      const children = node.children.flatMap((branch) => {
        const keptBranch = keepNode(branch, walk, depth + 1);
        return keptBranch !== undefined && keptBranch.kind === 'branch' ? [keptBranch] : [];
      });
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw':
      return own ? node : undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// A node matches on its own text; the bound counts these, and past it nothing more matches.
function matchesOwn(node: NavigatorNode, walk: Walk): boolean {
  const haystack = walk.index.get(node.id);
  if (haystack === undefined || !holdsEveryWord(haystack, walk.words)) {
    return false;
  }
  return walk.budget.take();
}

function childrenOf(node: NavigatorNode): readonly NavigatorNode[] {
  switch (node.kind) {
    case 'component':
    case 'element':
      return node.children ?? [];
    case 'map':
    case 'chunk-group':
    case 'branch':
    case 'cond':
      return node.children;
    case 'text':
    case 'expr':
    case 'raw':
    case 'comment':
    case 'raw-line':
      return [];
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// What a person can type to find a node: what it is called, its class and id, and its words.
function nodeText(node: NavigatorNode): string {
  switch (node.kind) {
    case 'component':
    case 'element':
      return [node.name, attributeText(node.props?.['class']), attributeText(node.props?.['className']), attributeText(node.props?.['id'])].join(' ');
    case 'raw':
    case 'chunk-group':
      return node.name;
    case 'text':
    case 'expr':
    case 'raw-line':
      return node.value;
    case 'map':
      return node.head;
    case 'cond':
      return node.test;
    case 'comment':
    case 'branch':
      return '';
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function attributeText(attribute: { readonly type: string; readonly value?: string } | undefined): string {
  return attribute !== undefined && attribute.type !== 'bare' && attribute.value !== undefined ? attribute.value : '';
}

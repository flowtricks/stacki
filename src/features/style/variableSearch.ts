import { assert } from '../../../shared/core/assert';
import type { ProjectVariable } from './model/webflow';

// The one ranking behind every variable list that is searched: the picker's own search box and the
// list that follows a reference being typed in a value field (the Custom value editor included).
//
// Why a ranking and not a filter: matching the query anywhere in the name, the value or the
// group put `--section-space-nav` and every variable whose VALUE was `var(--space-7)` level with
// `--space-1`. Someone typing `--space-` means the names that start that way, so those come first.
//
// Tiers, strictly in order (a lower tier always beats a higher one):
//   0  the name starts with the query (an exact name first), with or without the leading `--`
//   1  a word of the name starts with it (after `-`, `_`, `.`, `/` or a camelCase hump)
//   2  the name contains it
//   3  the value, or the alias target it names, starts with it
//   4  the value contains it
//   5  the collection or group (the file or scope heading) contains it
// Within a tier: natural order (`space-2` before `space-10`), then declaration order.
//
// A query of several words ranks by its weakest word, and every word must match somewhere.

export type VariableRank = number;

/** The most rows a ranked list returns; a project past this is not one a person scans by eye. */
export const RANKED_VARIABLES_MAX = 4_096;

const TIER_NAME_EXACT = 0;
const TIER_NAME_PREFIX = 1;
const TIER_NAME_WORD = 2;
const TIER_NAME_CONTAINS = 3;
const TIER_VALUE_PREFIX = 4;
const TIER_VALUE_CONTAINS = 5;
const TIER_SCOPE = 6;

// One lowercase copy of the searchable text per variable, built once: ranking a keystroke then
// touches strings only, and never re-lowercases the whole project.
interface SearchIndex {
  readonly name: string;
  readonly nameCased: string;
  readonly value: string;
  readonly scope: string;
}
const INDEXES = new WeakMap<ProjectVariable, SearchIndex>();

function indexOf(variable: ProjectVariable): SearchIndex {
  const known = INDEXES.get(variable);
  if (known !== undefined && known.nameCased === variable.name) {
    return known;
  }
  const built = {
    name: variable.name.toLowerCase(),
    nameCased: variable.name,
    value: variable.value.toLowerCase(),
    scope: `${variable.collection}/${variable.group}`.toLowerCase(),
  };
  INDEXES.set(variable, built);
  return built;
}

/** The words of a search: lower case, split on whitespace, each without its leading `--`. */
export function queryWords(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (word.startsWith('--') ? word.slice(2) : word));
}

// Is there a word boundary in the name just before `at`?
function boundaryAt(name: string, nameCased: string, at: number): boolean {
  const before = name[at - 1];
  if (before === '-' || before === '_' || before === '.' || before === '/') {
    return true;
  }
  const previous = nameCased[at - 1] ?? '';
  const current = nameCased[at] ?? '';
  return previous !== '' && previous === previous.toLowerCase() && previous !== previous.toUpperCase() && current !== current.toLowerCase();
}

function wordBoundaryMatch(index: SearchIndex, word: string): boolean {
  let from = index.name.indexOf(word, 1);
  while (from !== -1) {
    if (boundaryAt(index.name, index.nameCased, from)) {
      return true;
    }
    from = index.name.indexOf(word, from + 1);
  }
  return false;
}

// The tier of one word against one variable, or undefined when it is nowhere in it.
function wordTier(index: SearchIndex, word: string): number | undefined {
  if (word === '') {
    return TIER_NAME_PREFIX;
  }
  if (index.name === word) {
    return TIER_NAME_EXACT;
  }
  if (index.name.startsWith(word)) {
    return TIER_NAME_PREFIX;
  }
  if (wordBoundaryMatch(index, word)) {
    return TIER_NAME_WORD;
  }
  if (index.name.includes(word)) {
    return TIER_NAME_CONTAINS;
  }
  // A value written `--space-7` or `var(--space-7)` is searched with its dashes, as typed.
  const raw = word;
  if (index.value.startsWith(raw) || index.value.startsWith(`--${raw}`) || index.value.startsWith(`var(--${raw}`)) {
    return TIER_VALUE_PREFIX;
  }
  if (index.value.includes(raw)) {
    return TIER_VALUE_CONTAINS;
  }
  if (index.scope.includes(raw)) {
    return TIER_SCOPE;
  }
  return undefined;
}

/** How well `variable` answers `query` (lower is better), or undefined when it does not. */
export function rankVariable(variable: ProjectVariable, query: string): VariableRank | undefined {
  const words = queryWords(query);
  if (words.length === 0) {
    return TIER_NAME_PREFIX;
  }
  const index = indexOf(variable);
  let weakest = TIER_NAME_EXACT;
  for (const word of words) {
    const tier = wordTier(index, word);
    if (tier === undefined) {
      return undefined;
    }
    weakest = Math.max(weakest, tier);
  }
  // An exact name only outranks a prefix when it is the whole query.
  return weakest === TIER_NAME_EXACT && words.length > 1 ? TIER_NAME_PREFIX : weakest;
}

const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The variables that answer `query`, best first: tier, then natural name order, then the order given.
 * An empty query returns the list as it came. Hidden variables are the caller's to exclude before.
 */
export function rankVariables(variables: readonly ProjectVariable[], query: string): ProjectVariable[] {
  if (queryWords(query).length === 0) {
    return [...variables];
  }
  const ranked: Array<{ readonly variable: ProjectVariable; readonly rank: VariableRank; readonly position: number }> = [];
  for (const [position, variable] of variables.entries()) {
    const rank = rankVariable(variable, query);
    if (rank !== undefined) {
      ranked.push({ variable, rank, position });
    }
  }
  ranked.sort((left, right) => left.rank - right.rank || NATURAL.compare(left.variable.name, right.variable.name) || left.position - right.position);
  assert(ranked.length <= variables.length, 'rankVariables: ranking never adds a row');
  return ranked.slice(0, RANKED_VARIABLES_MAX).map((entry) => entry.variable);
}

/** Does `variable` answer `query` at all? */
export function matchesVariableQuery(variable: ProjectVariable, query: string): boolean {
  return rankVariable(variable, query) !== undefined;
}

/**
 * The best (lowest) rank among `variables`, or undefined when none match: what orders a group
 * or a file heading when a search is on.
 */
export function bestRank(variables: readonly ProjectVariable[], query: string): VariableRank | undefined {
  let best: VariableRank | undefined;
  for (const variable of variables) {
    const rank = rankVariable(variable, query);
    if (rank !== undefined && (best === undefined || rank < best)) {
      best = rank;
    }
  }
  return best;
}

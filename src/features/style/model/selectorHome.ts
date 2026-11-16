// The stylesheet a selected selector is already written in, and when "Add custom
// styles in" follows it.
//
// Choosing a selector should point new declarations at the file that holds its rules,
// not at whichever stylesheet is first in page order. The decision is pure so it can be
// tested without a panel: it reads rules as plain values and writes nothing.

import { assert } from '../../../../shared/core/assert';
import { selectorKey } from './resolved';
import { canonicalCompound } from './selectorParse';

/** One rule as the decision reads it: where it lives, where it sits in the cascade, what it selects. */
export interface HomeRule {
  readonly embedKey: string;
  /** Position in the cascade; a larger number is later and wins a tie. */
  readonly order: number;
  /** The query the rule sits in ('' for Base). */
  readonly context: string;
  readonly selectorTexts: readonly string[];
}

// An exact selector outranks a rule for only part of it.
const MATCH_PART = 1;
const MATCH_EXACT = 2;

interface Candidate {
  readonly embedKey: string;
  readonly order: number;
  readonly match: number;
  readonly specificity: number;
}

/**
 * The embed that holds the active selector's rules.
 *
 * A rule counts when one of its selectors equals the active selector, or is a single
 * compound whose tag, classes and attributes are all present in it with the same state
 * and pseudo-element: `.home-hero_height` is the home of `div.home-hero_height[data-x]`
 * the element carries, even though the text differs.
 *
 * Several files may define it. Rules in the current query win over rules elsewhere. Among
 * those, the exact selector beats a part, then the more specific part, then the LAST in
 * cascade order, because that rule wins the tie and is the one a new declaration should
 * sit beside. When the selector has no rule in the current query, the first in cascade
 * order of those in other queries is the home (Base is written before its queries).
 * Undefined when no file defines it: the caller keeps its default.
 */
export function selectorHomeKey(rules: readonly HomeRule[], context: string, activeSelector: string): string | undefined {
  assert(activeSelector.length >= 0, 'selectorHomeKey: a selector text');
  const active = canonicalCompound(activeSelector);
  const activeTokens = new Set(active.tokens);
  const activeKey = selectorKey(activeSelector);
  const here: Candidate[] = [];
  const elsewhere: Candidate[] = [];
  for (const rule of rules) {
    const best = bestMatch(rule, activeKey, active, activeTokens);
    if (best === undefined) {
      continue;
    }
    (rule.context === context ? here : elsewhere).push({ embedKey: rule.embedKey, order: rule.order, ...best });
  }
  if (here.length > 0) {
    return here.reduce((left, right) => (outranks(right, left) ? right : left)).embedKey;
  }
  if (elsewhere.length === 0) {
    return undefined;
  }
  const exactFirst = elsewhere.filter((candidate) => candidate.match === MATCH_EXACT);
  const pool = exactFirst.length > 0 ? exactFirst : elsewhere;
  return pool.reduce((left, right) => (right.order < left.order ? right : left)).embedKey;
}

function outranks(candidate: Candidate, current: Candidate): boolean {
  if (candidate.match !== current.match) {
    return candidate.match > current.match;
  }
  if (candidate.specificity !== current.specificity) {
    return candidate.specificity > current.specificity;
  }
  return candidate.order > current.order;
}

function bestMatch(
  rule: HomeRule,
  activeKey: string,
  active: ReturnType<typeof canonicalCompound>,
  activeTokens: ReadonlySet<string>,
): Pick<Candidate, 'match' | 'specificity'> | undefined {
  let best: Pick<Candidate, 'match' | 'specificity'> | undefined;
  for (const text of rule.selectorTexts) {
    if (selectorKey(text) === activeKey) {
      return { match: MATCH_EXACT, specificity: active.tokens.length };
    }
    const part = canonicalCompound(text);
    // A bare tag (`div`) is the whole project's, not this selector's.
    if (!part.oneCompound || !active.oneCompound || part.tokens.every((token) => token.startsWith('tag:'))) {
      continue;
    }
    if (part.pseudoElement !== active.pseudoElement || part.pseudoClasses.join() !== active.pseudoClasses.join()) {
      continue;
    }
    if (!part.tokens.every((token) => activeTokens.has(token))) {
      continue;
    }
    if (best === undefined || part.tokens.length > best.specificity) {
      best = { match: MATCH_PART, specificity: part.tokens.length };
    }
  }
  return best;
}

/** A manual pick of "Add custom styles in", and the selection it was made for. */
export interface ManualSourcePick {
  readonly selectionKey: string;
  readonly sourceKey: string;
}

export interface SourceFollowInput {
  /** The element and active selector together: any change of either is a new selection. */
  readonly selectionKey: string;
  /** The file that defines the selection's selector, if any. */
  readonly homeKey: string | undefined;
  readonly manualPick: ManualSourcePick | undefined;
}

export type SourceFollow =
  | { readonly kind: 'keep'; readonly manualPick: ManualSourcePick | undefined }
  | { readonly kind: 'move'; readonly sourceKey: string; readonly manualPick: undefined };

/**
 * Where "Add custom styles in" goes for this selection. A manual pick holds for as long
 * as the selection it was made for; a new selection forgets it. With no manual pick the
 * target is the selector's home file, and with no home it is left as it is.
 */
export function followSource(input: SourceFollowInput): SourceFollow {
  const { homeKey, manualPick, selectionKey } = input;
  if (manualPick !== undefined && manualPick.selectionKey === selectionKey) {
    return { kind: 'keep', manualPick };
  }
  if (homeKey === undefined) {
    return { kind: 'keep', manualPick: undefined };
  }
  return { kind: 'move', sourceKey: homeKey, manualPick: undefined };
}

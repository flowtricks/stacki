// Cascade resolution → a rule-centric, editable model.
//
// We surface each matching rule as its own card (selector + its declaration
// list), because all the editing operations the panel offers — rename a
// property, change a value, add, remove, reorder — are scoped to a single rule.
// Cascade information is preserved as per-declaration status: among the matching
// BASE rules (no pseudo-class / pseudo-element / @media), each property has one
// winner (by !important, then specificity, then document order); losing
// declarations are flagged `overriddenBy` so you still see what actually applies.

import { canonicalCompound, compareSpecificity, matchSelectorList, type MatchTarget } from './selectors';
import type { ParsedRule, SelectorInfo, Specificity } from './styleTypes';
import { assert } from '../../../../shared/core/assert';

export type RuleKind = 'base' | 'pseudo-class' | 'pseudo-element' | 'at-rule';

// The interaction states the panel views (mirrors resolved.ts). A selector is
// "base" (applies in the resting view) unless its SUBJECT carries one of these or
// a pseudo-element. Structural pseudos (`:first-child`, `:nth-child`, `:not`) and
// pseudos on an ANCESTOR (`.u-section:first-child .u-heading`) keep it base — the
// subject is still styled at rest — so they must NOT push it into the pseudo bucket.
const VIEW_STATES = new Set([':hover', ':focus', ':active']);
function subjectHasState(text: string): boolean {
  return canonicalCompound(text).pseudoClasses.some((pseudo) => VIEW_STATES.has(pseudo));
}

export type DeclStatus = {
  winning: boolean;
  /** Selector of the declaration that overrides this one, when not winning. */
  overriddenBy: string | undefined;
};

export type MatchedRule = {
  rule: ParsedRule;
  /** The selectors (within the rule's list) that matched the element. */
  matchedSelectors: SelectorInfo[];
  kind: RuleKind;
  conditional: boolean;
  /** Display label: strongest matched selector, prefixed with any at-context. */
  label: string;
  /** Per-declaration cascade status, keyed by declId. */
  declStatus: Record<string, DeclStatus>;
};

export type RuleModel = {
  base: MatchedRule[];
  conditional: MatchedRule[];
  matchedRuleCount: number;
};

type Hit = {
  rule: ParsedRule;
  matchedSelectors: SelectorInfo[];
  strongestBase: { selector: SelectorInfo; specificity: Specificity } | undefined;
  conditional: boolean;
  kind: RuleKind;
  label: string;
};

/**
 * Cascade tie-break for one property, winner-first: `!important`, then
 * specificity, then document order (later wins). Shared by computeRuleModel and
 * the resolved-style model (lib/resolved.ts) so both agree on who wins.
 */
export function compareCascade(
  left: { important: boolean; specificity: Specificity },
  right: { important: boolean; specificity: Specificity },
  leftOrder: number,
  rightOrder: number,
): number {
  if (left.important !== right.important) {
    return left.important ? -1 : 1;
  }
  const spec = compareSpecificity(right.specificity, left.specificity);
  if (spec !== 0) {
    return spec;
  }
  return rightOrder - leftOrder; // later wins on a tie
}

function strongestOf(selectors: SelectorInfo[]): { selector: SelectorInfo; specificity: Specificity } | undefined {
  let best: { selector: SelectorInfo; specificity: Specificity } | undefined;
  for (const selector of selectors) {
    if (!best || compareSpecificity(selector.specificity, best.specificity) > 0) {
      best = { selector, specificity: selector.specificity };
    }
  }
  return best;
}

export async function computeRuleModel(rules: ParsedRule[], target: MatchTarget): Promise<RuleModel> {
  const hits: Hit[] = [];
  for (const rule of rules) {
    const results = await matchSelectorList(rule.selectorText, target);
    const matchedSelectors = rule.selectors.filter((_, index) => results[index]?.matched);
    if (matchedSelectors.length) {
      hits.push(classifyHit(rule, matchedSelectors));
    }
  }

  const winners = cascadeWinners(hits);
  const base: MatchedRule[] = [];
  const conditional: MatchedRule[] = [];
  for (const hit of hits) {
    const matched: MatchedRule = {
      rule: hit.rule,
      matchedSelectors: hit.matchedSelectors,
      kind: hit.kind,
      conditional: hit.conditional,
      label: hit.label,
      declStatus: declStatusOf(hit, winners),
    };
    (hit.conditional ? conditional : base).push(matched);
  }

  base.sort((left, right) => left.rule.order - right.rule.order);
  conditional.sort((left, right) => left.rule.order - right.rule.order);
  assert(base.length + conditional.length === hits.length, 'Every hit lands in one bucket');
  return { base, conditional, matchedRuleCount: hits.length };
}

// Which bucket a matched rule belongs in, and the label its chip shows.
function classifyHit(rule: ParsedRule, matchedSelectors: SelectorInfo[]): Hit {
  assert(matchedSelectors.length > 0, 'classifyHit: a hit matched at least one selector');
  // Show every selector in the rule that actually targets this element — so a
  // grouped rule like `::before, ::after { … }` lists both halves.
  const selectorText = matchedSelectors.map((selector) => selector.text).join(', ');
  const hit = { rule, matchedSelectors, strongestBase: undefined };
  if (rule.atContext.length > 0) {
    const label = `${rule.atContext.join(' › ')} ${selectorText}`;
    return { ...hit, conditional: true, kind: 'at-rule', label };
  }
  const baseSelectors = matchedSelectors.filter((selector) => !subjectHasState(selector.text) && selector.pseudoElement === undefined);
  if (baseSelectors.length) {
    const strongestBase = strongestOf(baseSelectors);
    return { ...hit, strongestBase, conditional: false, kind: 'base', label: selectorText };
  }
  const kind = matchedSelectors.some((selector) => selector.pseudoElement !== undefined) ? 'pseudo-element' : 'pseudo-class';
  return { ...hit, conditional: true, kind, label: selectorText };
}

type Contribution = {
  declId: string;
  prop: string;
  important: boolean;
  specificity: Specificity;
  seq: number;
  selectorText: string;
};
type Winner = { declId: string; selectorText: string };

// Cascade winners among base hits, keyed by property.
function cascadeWinners(hits: readonly Hit[]): Map<string, Winner> {
  const contributions: Contribution[] = [];
  let seq = 0;
  for (const hit of hits) {
    if (hit.conditional || !hit.strongestBase) {
      continue;
    }
    for (const decl of hit.rule.declarations) {
      contributions.push({
        declId: decl.declId,
        prop: decl.prop,
        important: decl.important,
        specificity: hit.strongestBase.specificity,
        seq: seq++,
        selectorText: hit.strongestBase.selector.text,
      });
    }
  }

  const winners = new Map<string, Winner>();
  const byProp = new Map<string, Contribution[]>();
  contributions.forEach((contribution) => {
    const list = byProp.get(contribution.prop) ?? [];
    list.push(contribution);
    byProp.set(contribution.prop, list);
  });
  byProp.forEach((list, prop) => {
    const winner = [...list].sort((left, right) => compareCascade(left, right, left.seq, right.seq))[0];
    if (winner === undefined) {
      throw new Error(`Cascade invariant failed: ${prop} has no contributions`);
    }
    winners.set(prop, { declId: winner.declId, selectorText: winner.selectorText });
  });
  assert(winners.size === byProp.size, 'One winner per contested property');
  return winners;
}

function declStatusOf(hit: Hit, winners: ReadonlyMap<string, Winner>): Record<string, DeclStatus> {
  const declStatus: Record<string, DeclStatus> = {};
  for (const decl of hit.rule.declarations) {
    if (hit.conditional) {
      declStatus[decl.declId] = { winning: true, overriddenBy: undefined };
      continue;
    }
    const winner = winners.get(decl.prop);
    declStatus[decl.declId] =
      winner && winner.declId === decl.declId
        ? { winning: true, overriddenBy: undefined }
        : { winning: false, overriddenBy: winner ? winner.selectorText : undefined };
  }
  return declStatus;
}

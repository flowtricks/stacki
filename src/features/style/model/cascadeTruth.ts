// The panel's winner, checked against the page's own.
//
// The panel reads the project's CSS and ranks it (cascadeResolve.ts). That reading can miss what
// the browser knows: which stylesheet loads first, a rule its parser could not place, a value set
// by script. So after ranking, the canvas is asked which declaration it actually applies
// (shared/properties/cascadeOrigin.ts) and each property is settled one of three ways:
//   confirmed: the browser's winner is the listed winner (or says the same value): nothing changes;
//   corrected: the browser's winner is another listed rule: that rule is crowned, the document
//              order the browser reports replaces the guess, and every loser says why it lost;
//   unlisted:  no listed rule explains the browser's winner: the used value gets a row of its own
//              ("source not listed") and no listed rule is crowned, because a badge on a rule that
//              does not produce the used value is a lie.
// Only the resting state of the element in the base context is checked: the browser answers for
// the element as it renders now, not for a hover state or a ::before box.

import { assert } from '../../../../shared/core/assert';
import type { CascadeOrigin, CascadeProperty } from '../../../../shared/properties/cascadeOrigin';
import { compareCascade } from './cascade';
import { explainLoss } from './cascadeResolve';
import type { Contributor, ResolvedProp, ResolvedStyle } from './resolved';
import { selectorListMembers } from './selectors';

/** How one property was settled against the browser. */
export type TruthVerdict = 'confirmed' | 'corrected' | 'unlisted';

// A selector spelled one way: the browser serializes `[a=b]` as `[a="b"]` and puts one space around combinators.
export function normalizeSelectorText(text: string): string {
  return text
    .replace(/['"]/g, '')
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether a listed selector is one the browser's rule names (a rule's selector list holds it). */
export function sameSelector(listed: string, browser: string): boolean {
  const wanted = normalizeSelectorText(listed);
  return selectorListMembers(browser).some((member) => normalizeSelectorText(member.text) === wanted) || normalizeSelectorText(browser) === wanted;
}

const ZERO_LENGTH = /^[+-]?0*\.?0+(?:px|rem|em|%|vw|vh|ch|ex|pt)?$/;

/** Whether two declared values say the same: whitespace, case, `!important` and a unit on zero do not count. */
export function sameDeclaredValue(left: string, right: string): boolean {
  const clean = (value: string) =>
    value
      .replace(/!important/gi, '')
      .replace(/;\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/(^|\s)0(?:\.0+)?(?:px|rem|em|%)(?=\s|$)/g, '$10');
  const first = clean(left);
  const second = clean(right);
  if (first === second) {
    return true;
  }
  return ZERO_LENGTH.test(first) && ZERO_LENGTH.test(second);
}

function explains(contributor: Contributor, origin: CascadeOrigin): boolean {
  if (contributor.important !== origin.important) {
    return false;
  }
  if (!sameDeclaredValue(contributor.value, origin.value)) {
    return false;
  }
  if (origin.selector === 'style') {
    return contributor.origin === 'inline';
  }
  return contributor.origin === 'embed' && sameSelector(contributor.selectorText, origin.selector);
}

// The listed contributor for each browser candidate, each used once, in the browser's document order.
function mapCandidates(contributors: readonly Contributor[], candidates: readonly CascadeOrigin[]): Map<CascadeOrigin, Contributor> {
  const taken = new Set<Contributor>();
  const mapped = new Map<CascadeOrigin, Contributor>();
  for (const candidate of candidates) {
    // Equal text pairs up in order: the browser's n-th such declaration is the n-th listed one.
    const match = [...contributors]
      .sort((left, right) => left.order - right.order)
      .find((contributor) => !taken.has(contributor) && explains(contributor, candidate));
    if (match !== undefined) {
      taken.add(match);
      mapped.set(candidate, match);
    }
  }
  assert(mapped.size <= candidates.length, 'mapCandidates: no candidate maps twice');
  return mapped;
}

function describeConditions(origin: CascadeOrigin): string | undefined {
  return origin.conditions.length === 0 ? undefined : origin.conditions.join(' › ');
}

// The row for a used value no listed rule explains.
function usedValueContributor(prop: string, truth: CascadeProperty): Contributor {
  const origin = truth.winner;
  const condition = origin === undefined ? undefined : describeConditions(origin);
  return {
    selectorText: origin?.selector ?? '',
    ...(condition === undefined ? {} : { display: condition }),
    value: truth.used,
    important: origin?.important ?? false,
    specificity: [0, 0, 0],
    order: Number.MAX_SAFE_INTEGER,
    ruleId: `browser:${prop}`,
    origin: 'browser',
    isSelected: false,
    winning: true,
    complexOnly: false,
  };
}

function settle(prop: string, resolved: ResolvedProp, truth: CascadeProperty): { readonly next: ResolvedProp; readonly verdict: TruthVerdict } {
  const browserWinner = truth.winner;
  if (browserWinner === undefined) {
    return { next: resolved, verdict: 'confirmed' };
  }
  const mapped = mapCandidates(resolved.contributors, truth.candidates);
  const crowned = mapped.get(browserWinner) ?? resolved.contributors.find((contributor) => explains(contributor, browserWinner));
  if (crowned === undefined) {
    // The listed winner may still say the browser's value (a rule the matcher could not tie to the browser's text).
    if (sameDeclaredValue(resolved.winner.value, browserWinner.value) && resolved.winner.important === browserWinner.important) {
      return { next: resolved, verdict: 'confirmed' };
    }
    const used = usedValueContributor(prop, truth);
    const losers = resolved.contributors.map((contributor) => ({ ...contributor, winning: false, lossReason: 'other' as const }));
    const contributors = [used, ...losers];
    return { next: { ...resolved, winner: used, overridden: resolved.selectedValue !== undefined, contributors }, verdict: 'unlisted' };
  }
  // The browser's document order replaces the panel's guess for every rule it could place.
  const ordered = resolved.contributors.map((contributor) => {
    const hit = [...mapped.entries()].find(([, listed]) => listed === contributor);
    return hit === undefined ? { ...contributor } : { ...contributor, order: hit[0].order };
  });
  const winner = ordered.find(
    (contributor) => contributor.ruleId === crowned.ruleId && contributor.origin === crowned.origin && contributor.selectorText === crowned.selectorText,
  );
  assert(winner !== undefined, 'settle: the crowned rule is among the contributors');
  const rest = ordered.filter((contributor) => contributor !== winner).sort((left, right) => compareCascade(left, right, left.order, right.order));
  const contributors = [
    { ...winner, winning: true },
    ...rest.map((contributor) => ({ ...contributor, winning: false, lossReason: explainLoss({ ...contributor }, { ...winner }) ?? ('other' as const) })),
  ];
  const first = contributors[0];
  assert(first !== undefined, 'settle: the winner leads');
  const editing = contributors.find((contributor) => contributor.editing === true);
  const verdict: TruthVerdict = first.ruleId === resolved.winner.ruleId && first.selectorText === resolved.winner.selectorText ? 'confirmed' : 'corrected';
  return { next: { ...resolved, winner: first, overridden: editing !== undefined && editing.ruleId !== first.ruleId, contributors }, verdict };
}

/**
 * The resolved style with each property the page answered for checked against its winner.
 * Properties the page did not answer for keep the panel's own reading.
 */
export function applyCascadeTruth(resolved: ResolvedStyle, truth: ReadonlyMap<string, CascadeProperty>): ResolvedStyle {
  if (truth.size === 0) {
    return resolved;
  }
  const props = new Map(resolved.props);
  let changed = false;
  for (const [prop, answer] of truth) {
    const current = props.get(prop);
    if (current !== undefined) {
      const { next } = settle(prop, current, answer);
      if (next !== current) {
        props.set(prop, next);
        changed = true;
      }
    }
  }
  assert(props.size === resolved.props.size, 'applyCascadeTruth: no property appears or vanishes');
  return changed ? { ...resolved, props } : resolved;
}

// Whether a nested query can reach the selected element.
//
// A query nested inside `.layout { }` styles only `.layout` and what sits inside
// it: a rule written there for an element outside `.layout` is written and does
// nothing. So the dropdown lists a nested query only when the element matches
// the wrapper or has an ancestor that does, which is the element matching
// `W` or `W *`. Those two probes are asked of the rendered page with the rest of
// the element's selectors (canvasAsk.ts), and that answer is exact.
//
// Without a canvas answer the source matcher decides, but only for a wrapper it
// can read whole: one with any pseudo-class (`.a:hover`, `:global(.a)`,
// `:is(…)`) is left undecided, and so is a miss on a tree that stops at a
// component's edge (the matching ancestor may sit above it). Undecided is shown,
// never hidden: offering a query that turns out not to apply costs a click,
// hiding one that does leaves no way into it.

import { assert } from '../../../../shared/core/assert';
import { matchSelectorList, type MatchTarget } from './selectors';
import { selectorListLayers, selectorListMembers } from './selectorParse';
import { queryPlacementOf } from './queryWrapper';
import type { PanelLayer } from './resolved';
import type { ParsedRule } from './styleTypes';

/** What is known about one wrapper and the selected element. */
export type WrapperReach = { readonly kind: 'reaches' } | { readonly kind: 'misses' } | { readonly kind: 'unknown' };

export const QUERY_REACH_LIMITS = {
  /** Members one wrapper list may have before it is left undecided. */
  wrapperMembersMax: 64,
  /** Distinct wrappers probed per stylesheet set; past it the rest stay undecided. */
  wrappersMax: 256,
} as const satisfies Record<string, number>;

/** The selectors that say the element is the wrapper, or inside it. */
export function wrapperProbes(wrapper: string): string[] {
  const members = selectorListMembers(wrapper)
    .map((member) => member.text.trim())
    .filter((member) => member.length > 0);
  if (members.length > QUERY_REACH_LIMITS.wrapperMembersMax) {
    return [];
  }
  const probes = members.flatMap((member) => [member, `${member} *`]);
  assert(probes.length === members.length * 2, 'wrapperProbes: the element itself and its ancestors, per member');
  return probes;
}

/**
 * Whether a wrapper can hold `layer`'s styles at all. The probes drop pseudo-elements,
 * so `.a::after` probes as `.a` and reads as reaching `.a`, but a query nested in it
 * styles only the ::after: the element's own list must not offer it, nor the
 * ::before's. A generated box has no children, so nothing sits inside one either.
 */
export function wrapperOnLayer(wrapper: string, layer: PanelLayer): boolean {
  if (layer === 'every') {
    return true;
  }
  const layers = selectorListLayers(wrapper);
  return layers.length === 0 || layers.includes('') || layers.includes(layer);
}

/** Every distinct wrapper a nested rule in `rules` sits in, bounded. */
export function nestedWrappersOf(rules: readonly ParsedRule[]): string[] {
  const wrappers = new Set<string>();
  for (const rule of rules) {
    if (wrappers.size >= QUERY_REACH_LIMITS.wrappersMax) {
      break;
    }
    if (rule.atContext.length === 0) {
      continue;
    }
    const placement = queryPlacementOf(rule);
    if (placement.kind === 'nested') {
      wrappers.add(placement.wrapper);
    }
  }
  assert(wrappers.size <= QUERY_REACH_LIMITS.wrappersMax, 'nestedWrappersOf: bounded');
  return [...wrappers];
}

/** Whether the element matches `wrapper` or sits inside it, as far as can be told. */
export async function reachOfWrapper(wrapper: string, target: MatchTarget | undefined): Promise<WrapperReach> {
  if (target === undefined) {
    return { kind: 'unknown' };
  }
  const probes = wrapperProbes(wrapper);
  if (probes.length === 0) {
    return { kind: 'unknown' };
  }
  // The rendered page first: its answer sees components, loops and runtime classes.
  let pageAnsweredAll = true;
  for (const probe of probes) {
    const hit = target.domMatched?.get(probe);
    if (hit === true) {
      return { kind: 'reaches' };
    }
    if (hit === undefined) {
      pageAnsweredAll = false;
    }
  }
  if (pageAnsweredAll) {
    return { kind: 'misses' };
  }
  // The source matcher reads classes, ids, tags, attributes and combinators. A
  // pseudo-class it may not model, so such a wrapper stays undecided.
  if (wrapper.includes(':')) {
    return { kind: 'unknown' };
  }
  for (const probe of probes) {
    const results = await matchSelectorList(probe, target);
    if (results.some((result) => result.matched)) {
      return { kind: 'reaches' };
    }
  }
  // Above a component's edge the ancestors are unknown, so a miss there is no answer.
  if (target.view.truncated) {
    return { kind: 'unknown' };
  }
  return { kind: 'misses' };
}

// The selector a nested query is written inside, for the style-context dropdown.
//
// A context is keyed by its at-rule chain alone (`@media (width < 42rem)`), so a
// query written at the top level and the same query nested inside `.layout { }`
// share one key. The dropdown still has to say WHERE the element's styles in it
// sit, or a nested query reads as a top-level one: the chip below would say
// `.layout {@}` while the dropdown above says only `@media (width < 42rem)`.
// This finds that wrapping selector from the parsed rules' own postcss nodes.

import { AtRule, Rule, type ChildNode, type Container, type Document } from 'postcss';
import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import type { RuleModel } from './cascade';
import { contextKeyOf, type ContextKey } from './resolved';
import type { ParsedRule } from './styleTypes';

// The at-rules that open a style context (the same three css.ts walks into).
const CONDITIONAL_AT_RULES: ReadonlySet<string> = new Set(['media', 'supports', 'container']);

/**
 * Where a rule's innermost query sits: `top-level` when no rule encloses it, or
 * `nested` with the enclosing selectors, outermost first and joined by a space
 * (`.layout`, `.layout .card`). `none` when the rule is in no query at all.
 */
export type QueryPlacement = { readonly kind: 'none' } | { readonly kind: 'top-level' } | { readonly kind: 'nested'; readonly wrapper: string };

export function queryPlacementOf(rule: ParsedRule): QueryPlacement {
  if (rule.atContext.length === 0) {
    return { kind: 'none' };
  }
  // A nested query's own bare declarations are carried by the at-rule node itself
  // (css.ts binds the rule to it), so the search starts at the node, not above it.
  const query = innermostQuery(rule.node);
  assert(query !== undefined, 'queryPlacementOf: a rule with an at-context sits inside a query');
  const selectors = enclosingSelectors(query);
  if (selectors.length === 0) {
    return { kind: 'top-level' };
  }
  return { kind: 'nested', wrapper: selectors.join(' ') };
}

/**
 * The wrapping selector each context is shown with: present only when every rule
 * styling the element there sits in a query nested inside the SAME selector. A
 * context reached both at the top level and nested, or nested under two different
 * selectors, has no single answer, so it is shown on one line as before.
 */
export function contextWrappers(model: RuleModel, contextKeys: readonly ContextKey[]): ReadonlyMap<ContextKey, string> {
  const wanted = new Set(contextKeys);
  const placements = new Map<ContextKey, Set<string>>();
  const matched = [...model.base, ...model.conditional];
  for (const entry of matched) {
    const key = contextKeyOf(entry.rule);
    if (key === '' || !wanted.has(key) || entry.rule.declarations.length === 0) {
      continue;
    }
    const placement = queryPlacementOf(entry.rule);
    const seen = placements.get(key) ?? new Set<string>();
    // A top-level placement is recorded as the empty wrapper, which can never be a
    // selector: it then makes the context's set disagree with any nested one.
    seen.add(placement.kind === 'nested' ? placement.wrapper : '');
    placements.set(key, seen);
  }
  const out = new Map<ContextKey, string>();
  for (const [key, seen] of placements) {
    if (seen.size === 1) {
      const [wrapper = ''] = seen;
      if (wrapper.length > 0) {
        out.set(key, wrapper);
      }
    }
  }
  assert(out.size <= wanted.size, 'contextWrappers: at most one wrapper per context asked about');
  return out;
}

// The nearest conditional at-rule at or above `node`. Bounded by the tree depth
// limit css.ts parses to, so a malformed parent chain cannot spin.
function innermostQuery(node: ChildNode): ChildNode | undefined {
  let current: ChildNode | Container | Document | undefined = node;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth += 1) {
    if (current === undefined || current.type === 'root' || current.type === 'document') {
      return undefined;
    }
    if (current instanceof AtRule && CONDITIONAL_AT_RULES.has(current.name.toLowerCase())) {
      return current;
    }
    current = current.parent;
  }
  assert(false, 'innermostQuery: the parent chain is deeper than the tree depth limit');
}

// The selectors of the rules enclosing `query`, outermost first. Stops at the
// next query up: selectors outside it wrap that query, not this one.
function enclosingSelectors(query: ChildNode): string[] {
  const selectors: string[] = [];
  let current: Container | Document | undefined = query.parent;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth += 1) {
    if (current === undefined || current.type === 'root' || current.type === 'document') {
      return selectors.reverse();
    }
    if (current instanceof AtRule && CONDITIONAL_AT_RULES.has(current.name.toLowerCase())) {
      return selectors.reverse();
    }
    if (current instanceof Rule) {
      selectors.push(current.selector.trim());
    }
    current = current.parent;
  }
  assert(false, 'enclosingSelectors: the parent chain is deeper than the tree depth limit');
}

// Where an authored query is written, and the style context each place is.
//
// A query written at the top level of a stylesheet and the same query nested
// inside `.layout { }` are different places: the nested one only reaches
// `.layout` and what sits inside it, and a rule written into it is written
// inside `.layout`. So each is its own context in the dropdown, keyed by WHERE
// the block is, not by the selected element's styles. A top-level query keeps
// its old key (its at-rule chain, `@media (width < 42rem)`); a nested one is
// keyed `<wrapper> { <chain> }` (`.layout { @media (width < 42rem) }`), which no
// top-level key can equal (those start with `@`), and which reads back into its
// two halves (nestedQueryOfKey) because neither half can hold a brace.
//
// The placement comes from the parsed stylesheets' own postcss nodes: the rules
// enclosing the innermost query, resolved through CSS nesting
// (css.ts resolveSelectorChain), are the wrapper.

import { AtRule, Rule, type ChildNode, type Container, type Document } from 'postcss';
import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import type { RuleModel } from './cascade';
import { resolveSelectorChain, type BlockPlacement, type NestStep } from './css';
import { contextKeyOf, indexContexts, type ContextInfo, type ContextKey, type StyleContext } from './resolved';
import type { ParsedRule } from './styleTypes';

export type { BlockPlacement } from './css';

// The at-rules that open a style context (the same three css.ts walks into).
const CONDITIONAL_AT_RULES: ReadonlySet<string> = new Set(['media', 'supports', 'container']);

// The text between a nested key's wrapper and its chain, and after the chain.
const NESTED_KEY_OPEN = ' { ';
const NESTED_KEY_CLOSE = ' }';
// Around the stylesheet a context's block is written in. The same query in two
// stylesheets is two places, so two rows: the key ends with the source's key
// (`@media (width < 50rem) ⟦astro:/p/Button.astro⟧`). Neither bracket can occur
// in a selector, a query or a source key, so the last opening splits it.
const SOURCE_KEY_OPEN = ' ⟦';
const SOURCE_KEY_CLOSE = '⟧';

/**
 * Where a rule's innermost query sits: `top-level` when no rule encloses it, or
 * `nested` with the selector the enclosing rules resolve to (`.layout`,
 * `.layout .card`). `none` when the rule is in no query at all.
 */
export type QueryPlacement = { readonly kind: 'none' } | BlockPlacement;

/** A nested query context's two halves. */
export type NestedQuery = { readonly wrapper: string; readonly atContext: string };

/** A context key's place (Base, a breakpoint, or a placed query key) and the
 *  stylesheet it names, when it names one. Typed queries, not yet written
 *  anywhere, name none. */
export type SourcedKey = { readonly placed: ContextKey; readonly source: string | undefined };

/** The key of a query placed in one stylesheet. */
export function sourcedContextKey(placed: ContextKey, source: string): ContextKey {
  assert(placed.length > 0, 'sourcedContextKey: Base is not a query of one stylesheet');
  assert(source.length > 0, 'sourcedContextKey: a source has a key');
  assert(!placed.includes(SOURCE_KEY_OPEN), 'sourcedContextKey: a placed key names no source');
  return `${placed}${SOURCE_KEY_OPEN}${source}${SOURCE_KEY_CLOSE}`;
}

/** A context key's placed part and its stylesheet. */
export function splitSourcedKey(key: ContextKey): SourcedKey {
  if (!key.endsWith(SOURCE_KEY_CLOSE)) {
    return { placed: key, source: undefined };
  }
  const split = key.lastIndexOf(SOURCE_KEY_OPEN);
  if (split <= 0) {
    return { placed: key, source: undefined };
  }
  const placed = key.slice(0, split);
  const source = key.slice(split + SOURCE_KEY_OPEN.length, key.length - SOURCE_KEY_CLOSE.length);
  assert(sourcedContextKey(placed, source) === key, 'splitSourcedKey: the parts rebuild the key');
  return { placed, source };
}

export function queryPlacementOf(rule: ParsedRule): QueryPlacement {
  if (rule.atContext.length === 0) {
    return { kind: 'none' };
  }
  // A nested query's own bare declarations are carried by the at-rule node itself
  // (css.ts binds the rule to it), so the search starts at the node, not above it.
  const query = innermostQuery(rule.node);
  assert(query !== undefined, 'queryPlacementOf: a rule with an at-context sits inside a query');
  const wrapper = resolveSelectorChain(enclosingSelectors(query));
  if (wrapper.length === 0) {
    return { kind: 'top-level' };
  }
  return { kind: 'nested', wrapper };
}

/** The dropdown key of a query written at `placement`. */
export function placedContextKey(atContext: string, placement: BlockPlacement): ContextKey {
  assert(atContext.startsWith('@'), 'placedContextKey: an at-context names a query');
  switch (placement.kind) {
    case 'top-level':
      return atContext;
    case 'nested': {
      assert(placement.wrapper.length > 0, 'placedContextKey: a nested query has a wrapper');
      const key = `${placement.wrapper}${NESTED_KEY_OPEN}${atContext}${NESTED_KEY_CLOSE}`;
      assert(!key.startsWith('@'), 'placedContextKey: a nested key never reads as a top-level one');
      return key;
    }
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

/** The context key a rule sits in: '' for Base, else its query and placement. */
export function ruleContextKey(rule: ParsedRule): ContextKey {
  const placement = queryPlacementOf(rule);
  switch (placement.kind) {
    case 'none':
      return '';
    case 'top-level':
    case 'nested':
      return placedContextKey(contextKeyOf(rule), placement);
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

/** A nested context key's wrapper and chain, or undefined for any other key. */
export function nestedQueryOfKey(sourcedKey: ContextKey): NestedQuery | undefined {
  const key = splitSourcedKey(sourcedKey).placed;
  if (key.length === 0 || key.startsWith('@') || key.startsWith('bp:')) {
    return undefined;
  }
  if (!key.endsWith(NESTED_KEY_CLOSE)) {
    return undefined;
  }
  // The chain holds no brace (a brace would have opened a block), so the last
  // opening is the one between the halves, whatever the wrapper holds.
  const split = key.lastIndexOf(NESTED_KEY_OPEN);
  if (split <= 0) {
    return undefined;
  }
  const wrapper = key.slice(0, split);
  const atContext = key.slice(split + NESTED_KEY_OPEN.length, key.length - NESTED_KEY_CLOSE.length);
  if (!atContext.startsWith('@')) {
    return undefined;
  }
  assert(placedContextKey(atContext, { kind: 'nested', wrapper }) === key, 'nestedQueryOfKey: the halves rebuild the key');
  return { wrapper, atContext };
}

/** The key a rule sits at, with its stylesheet: '' for Base. */
export function ruleSourcedContextKey(rule: ParsedRule): ContextKey {
  const placed = ruleContextKey(rule);
  return placed === '' ? '' : sourcedContextKey(placed, rule.embedKey);
}

/** Where a context's embed rules must sit: the placed key and the stylesheet.
 *  A breakpoint row (`bp:<id>`) stands for its query at the top level, in any
 *  stylesheet. Undefined for a context with no embed query. */
export function contextPlacement(context: Pick<StyleContext, 'key' | 'embedAtContext'>): SourcedKey | undefined {
  const atContext = context.embedAtContext;
  if (atContext === undefined || atContext === '') {
    return undefined;
  }
  if (context.key.startsWith('bp:')) {
    return { placed: atContext, source: undefined };
  }
  return splitSourcedKey(context.key);
}

/**
 * The element's matched rules as one context sees them: a rule in the same query
 * written at another place is dropped, so a nested context neither shows nor
 * edits the top-level block's rules, and the other way round. Rules in other
 * queries, and Base, are kept as they were.
 */
export function modelForContext(model: RuleModel, context: Pick<StyleContext, 'key' | 'embedAtContext'>): RuleModel {
  const placement = contextPlacement(context);
  const atContext = context.embedAtContext;
  if (placement === undefined || atContext === undefined) {
    return model;
  }
  const keep = (rule: ParsedRule) => {
    if (contextKeyOf(rule) !== atContext) {
      return true;
    }
    if (ruleContextKey(rule) !== placement.placed) {
      return false;
    }
    return placement.source === undefined || rule.embedKey === placement.source;
  };
  const base = model.base.filter((entry) => keep(entry.rule));
  const conditional = model.conditional.filter((entry) => keep(entry.rule));
  assert(base.length <= model.base.length, 'modelForContext: only drops rules');
  assert(conditional.length <= model.conditional.length, 'modelForContext: only drops rules');
  return { base, conditional, matchedRuleCount: base.length + conditional.length };
}

/** The placed contexts, each in its stylesheet, the element has at least one declaration in. */
export function contextKeysWithStyles(model: RuleModel): ReadonlySet<ContextKey> {
  const keys = new Set<ContextKey>();
  for (const entry of [...model.base, ...model.conditional]) {
    if (entry.rule.declarations.length === 0) {
      continue;
    }
    const key = ruleSourcedContextKey(entry.rule);
    if (key !== '') {
      keys.add(key);
    }
  }
  assert(!keys.has(''), 'contextKeysWithStyles: Base is not a query');
  return keys;
}

/**
 * The dropdown's per-row summary (dot, combos, wrapper line), each row read
 * through its own placement: a nested row's dot says whether the element has
 * styles in THAT block, not in the same query somewhere else.
 */
export function indexPlacedContexts(model: RuleModel, contexts: readonly StyleContext[]): ContextInfo[] {
  const infos = contexts.map((context): ContextInfo => {
    const atContext = context.embedAtContext;
    const nested = nestedQueryOfKey(context.key);
    const wrapper = nested === undefined ? {} : { wrapper: nested.wrapper };
    if (atContext === undefined) {
      return { key: context.key, hasStyles: false, styledCombos: [], bestTokens: undefined, ...wrapper };
    }
    const [info] = indexContexts(modelForContext(model, context), [atContext]);
    assert(info !== undefined, 'indexPlacedContexts: one summary per asked context');
    return { ...info, key: context.key, ...wrapper };
  });
  assert(infos.length === contexts.length, 'indexPlacedContexts: one summary per row');
  return infos;
}

/** A context key with one query in its chain renamed (the dropdown's pencil). */
export function renameQueryInContextKey(sourcedKey: ContextKey, from: string, next: string): ContextKey {
  const { placed, source } = splitSourcedKey(sourcedKey);
  const renamed = renamePlacedKey(placed, from, next);
  return source === undefined ? renamed : sourcedContextKey(renamed, source);
}

function renamePlacedKey(key: ContextKey, from: string, next: string): ContextKey {
  const swapChain = (chain: string) =>
    chain
      .split(' › ')
      .map((part) => (part === from ? next : part))
      .join(' › ');
  const nested = nestedQueryOfKey(key);
  if (nested === undefined) {
    return swapChain(key);
  }
  return placedContextKey(swapChain(nested.atContext), { kind: 'nested', wrapper: nested.wrapper });
}

/** Where a typed nesting path (`.hero { @container (…) { .title } }`) puts its
 *  innermost query: the selectors before that query step are its wrapper. */
export function placementOfPath(path: readonly NestStep[]): BlockPlacement {
  assert(path.length <= LIMITS.treeDepthMax, 'placementOfPath: a typed path is bounded');
  const selectors: string[] = [];
  let wrapperSelectors: readonly string[] = [];
  for (const step of path) {
    if (step.kind === 'selector') {
      selectors.push(step.selector);
    } else {
      wrapperSelectors = [...selectors];
    }
  }
  const wrapper = resolveSelectorChain(wrapperSelectors);
  return wrapper.length === 0 ? { kind: 'top-level' } : { kind: 'nested', wrapper };
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

// The raw selectors of every rule enclosing `query`, outermost first, across
// any queries between them: `.a { @media x { .b { @media y { … } } } }` is
// reached only inside `.a .b`, so both are its wrapper.
function enclosingSelectors(query: ChildNode): string[] {
  const selectors: string[] = [];
  let current: Container | Document | undefined = query.parent;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth += 1) {
    if (current === undefined || current.type === 'root' || current.type === 'document') {
      return selectors.reverse();
    }
    if (current instanceof Rule) {
      selectors.push(current.selector.trim());
    }
    current = current.parent;
  }
  assert(false, 'enclosingSelectors: the parent chain is deeper than the tree depth limit');
}

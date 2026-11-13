// CSS parsing and write-back for embed `<style>` blocks.
//
// Strategy: we hold the live postcss Root for each `<style>` region. Reads flow
// from the parsed tree; edits mutate AST nodes in place and re-stringify only
// the affected region, splicing it back into the embed code string. postcss
// preserves the original formatting (`raws`) of untouched nodes, so an edit to
// one value never reflows the rest of the author's code.

import postcss, { type Root, type Rule, type AtRule, type ChildNode } from 'postcss';
import type { ParsedDeclaration, ParsedRule, StyleRegion } from './styleTypes';
import { parseSelectorList, selectorListMembers } from './selectors';
import { ruleChainLevels, ruleHead, ruleLayout, sourceTextFromEditor } from './cssRuleText';
import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import { failureOf, type Failure } from './failureMessage';
import {
  type DeclarationValue,
  squash,
  childRule,
  childAtRule,
  findChildRuleBySelector,
  setDeclOnRule,
  appendDecl,
  placeChild,
  setDeclDirect,
} from './cssRegions';
export { type DeclarationValue, extractStyleRegions, parseRegion, splitEmbed, renderEmbed, directDecls, appendDecl } from './cssRegions';

export { atRuleQueryText, queryKey, splitQuery, countAtRuleQuery, renameAtRuleQuery } from './cssQueries';
import { splitQuery } from './cssQueries';

type WalkContext = {
  embedKey: string;
  embedLabel: string;
  fromComponent: boolean;
  componentName: string | undefined;
  regionIndex: number;
  idSeed: string;
  /** Shared running counter assigning cascade document order across embeds. */
  order: { n: number };
};

/** Split a selector list on top-level commas (ignoring commas inside `()`/`[]`). */
function splitTopLevelCommas(text: string): string[] {
  return selectorListMembers(text).map((member) => member.text);
}

/** Combine one parent selector with one nested selector per CSS nesting rules:
 *  `&` is replaced by the parent; otherwise the parent is prepended (so `.b` →
 *  `parent .b` and a leading combinator `> .b` → `parent > .b`). */
function combineNesting(parent: string, selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.includes('&')) {
    return trimmed.replace(/&/g, parent);
  }
  return `${parent} ${trimmed}`;
}

/** Resolve a nested rule's selector list against its parent's resolved selectors —
 *  the cartesian product, so grouped parents/children expand correctly. */
function resolveNestedSelectors(rawSelector: string, parents: string[]): string[] {
  const nested = splitTopLevelCommas(rawSelector);
  const out: string[] = [];
  for (const parent of parents) {
    for (const selector of nested) {
      out.push(combineNesting(parent, selector));
    }
  }
  return out;
}

/**
 * The selector a chain of nested rules resolves to, outermost raw selector first:
 * `['.layout', '&:hover', '.card']` → `.layout:hover .card`. A list at any level
 * expands to every combination, joined with `, `, and runs of whitespace collapse to
 * one space, so two spellings of one chain give one text. Empty for no rules.
 */
export function resolveSelectorChain(rawSelectors: readonly string[]): string {
  assert(rawSelectors.length <= LIMITS.treeDepthMax, 'resolveSelectorChain: a chain is no deeper than a parsed tree');
  let parents: string[] | undefined;
  for (const raw of rawSelectors) {
    parents = parents === undefined ? splitTopLevelCommas(raw) : resolveNestedSelectors(raw, parents);
  }
  const resolved = (parents ?? []).map((selector) => selector.trim().replace(/\s+/g, ' ')).filter((selector) => selector.length > 0);
  assert(
    resolved.every((selector) => !/\s{2}/.test(selector)),
    'resolveSelectorChain: whitespace is collapsed',
  );
  return resolved.join(', ');
}

/** Render a chain of SELECTOR ancestors as nested source for display, e.g.
 *  `['.hero', '.title']` → `.hero { .title }`. Queries aren't included (they show in
 *  the context dropdown), so a nested chip reads as the code the user is editing.
 *  `depth` is 0 for the outermost part; each part is one level, so the display path
 *  of a parsed tree never runs past the tree's own depth bound. */
function renderNestedPath(parts: string[], depth = 0): string {
  assert(depth <= LIMITS.treeDepthMax, 'renderNestedPath: depth limit');
  if (!parts.length) {
    return '';
  }
  const [head = '', ...rest] = parts;
  if (head === '@') {
    return rest.length ? `@ ${renderNestedPath(rest, depth + 1)}` : '@';
  }
  const restText = renderNestedPath(rest, depth + 1);
  // Braces when this selector wraps another selector, or when it's the outermost
  // selector with content (e.g. its own decls sit in a nested query → `.hero {@}`).
  // A nested selector whose only content is a query stays inline (`.title @`).
  if (rest.some((part) => part !== '@') || (depth === 0 && rest.length)) {
    return `${head} {${restText}}`;
  }
  return restText ? `${head} ${restText}` : head;
}

export function collectRules(region: StyleRegion, context: WalkContext): ParsedRule[] {
  if (!region.root) {
    return [];
  }
  const rules: ParsedRule[] = [];
  let ruleCounter = 0;

  // parentSelectors: undefined at the top level; the enclosing rule's RESOLVED selectors
  // once inside one. ancestorDisplay: the enclosing rules' RAW selectors plus `@`
  // markers for enclosing queries, in order, for the nested display.
  const walk = (container: Root | Rule | AtRule, atContext: string[], parentSelectors: string[] | undefined, ancestorDisplay: string[], depth: number) => {
    // A stylesheet is untrusted input: rules nested deeper than a page tree can be are
    // not offered, rather than walked without bound.
    if (depth > LIMITS.treeDepthMax) {
      return;
    }
    container.each((child: ChildNode) => {
      if (child.type === 'rule') {
        const node = child as Rule;
        const raw = node.selector.trim();
        const resolved = parentSelectors ? resolveNestedSelectors(node.selector, parentSelectors) : undefined;
        // Display path: enclosing selectors + `@` query markers. `&` collapses to the
        // parent (its decls belong to the enclosing selector).
        const displayPath = raw === '&' ? ancestorDisplay : [...ancestorDisplay, raw];
        const selectorsOnly = displayPath.filter((part) => part !== '@');
        // nestedDisplay: selector nesting only (Base view). queryDisplay: with `@` at
        // the query position (shown when viewing that query).
        const nestedDisplay = selectorsOnly.length > 1 ? renderNestedPath(selectorsOnly) : undefined;
        const queryDisplay = displayPath.includes('@') ? renderNestedPath(displayPath) : undefined;
        rules.push(buildRule(node, atContext, context, ruleCounter++, resolved, nestedDisplay, queryDisplay));
        const nextSelectors = resolved ?? splitTopLevelCommas(node.selector);
        walk(node, atContext, nextSelectors, displayPath, depth + 1);
      } else if (child.type === 'atrule') {
        const at = child as AtRule;
        const name = at.name.toLowerCase();
        // Conditional group at-rules wrap element styles that apply under a condition —
        // descend, carry the condition into the cascade context, and mark the query
        // position (`@`) in the display path so the chip can show WHERE the query sits.
        if (name === 'media' || name === 'supports' || name === 'container') {
          const nextContext = [...atContext, `@${at.name} ${at.params}`.trim()];
          const nextDisplay = [...ancestorDisplay, '@'];
          // A nested query's OWN bare declarations style the ENCLOSING selector within
          // the query. Surface them as a rule bound to the at-rule node itself (its
          // direct decls), so the authored bare form round-trips without an `& { }`.
          if (parentSelectors && parentSelectors.length && at.some((child) => child.type === 'decl')) {
            const selectorsOnly = nextDisplay.filter((part) => part !== '@');
            const nestedDisplay = selectorsOnly.length > 1 ? renderNestedPath(selectorsOnly) : undefined;
            const queryDisplay = renderNestedPath(nextDisplay);
            rules.push(buildRule(at as unknown as Rule, nextContext, context, ruleCounter++, parentSelectors, nestedDisplay, queryDisplay));
          }
          walk(at, nextContext, parentSelectors, nextDisplay, depth + 1);
        } else if (name === 'layer' && at.nodes) {
          walk(at, atContext, parentSelectors, ancestorDisplay, depth + 1);
        }
        // @keyframes / @font-face / @import etc. inject no element styles — skip.
      }
    });
  };

  walk(region.root, [], undefined, [], 0);
  return rules;
}

/**
 * Parse a selector typed in the "add a selector" field that uses CSS nesting and/or a
 * query — e.g. `.hero { .title }`, `.hero { @container (width < 50em) { .title } }`, or
 * `.hero { @container (width < 50em) }`. Returns the DEEPEST resolved selector and its
 * at-rule (query) context, or undefined when unparseable. A flat selector (no braces) is
 * left for the caller to use as-is.
 */
/** One step of a typed nesting path: a selector level or a query (at-rule) level. */
export type NestStep = { kind: 'selector'; selector: string } | { kind: 'atrule'; name: string; params: string };

export function parseNestedInput(input: string): { selector: string; atContext: string[]; path: NestStep[] } | undefined {
  const text = input.trim();
  if (!text) {
    return undefined;
  }
  // The add-selector field holds selectors/queries only (no declarations), so any
  // bare selector/at-rule sitting directly before a `}` needs a block for postcss to
  // parse the nesting — give it an empty one (`.hero { .title }` → `.hero { .title {} }`).
  const normalized = text.replace(/([^{}]+?)\s*\}/g, (_match, content) => {
    const trimmed = String(content).trim();
    return trimmed ? `${trimmed} {} }` : ' }';
  });
  let root: Root;
  try {
    root = postcss.parse(normalized);
  } catch {
    return undefined;
  }
  // Follow the single deepest branch (first rule/query child at each level).
  const path: NestStep[] = [];
  const QUERY_ATS = new Set(['media', 'container', 'supports']);
  let container: Root | Rule | AtRule = root;
  // Each pass descends one level. A snippet nested as deep as a whole page tree
  // may be is refused, never truncated.
  while (path.length < LIMITS.treeDepthMax) {
    const children: ChildNode[] = [];
    container.each((child: ChildNode) => {
      children.push(child);
    });
    const next = children.find((child) => child.type === 'rule' || (child.type === 'atrule' && QUERY_ATS.has((child as AtRule).name.toLowerCase())));
    if (!next) {
      break;
    }
    if (next.type === 'rule') {
      path.push({ kind: 'selector', selector: (next as Rule).selector.trim() });
      container = next as Rule;
    } else {
      const at = next as AtRule;
      path.push({ kind: 'atrule', name: at.name.toLowerCase(), params: at.params.trim() });
      container = at;
    }
  }
  if (path.length === LIMITS.treeDepthMax) {
    return undefined;
  }
  if (!path.length) {
    return undefined;
  }
  // Derive the resolved selector + query context from the path.
  let selector = '';
  const atContext: string[] = [];
  for (const step of path) {
    if (step.kind === 'selector') {
      const first = splitTopLevelCommas(step.selector)[0] ?? step.selector;
      selector = selector ? combineNesting(selector, first) : first;
    } else {
      atContext.push(`@${step.name} ${step.params}`.trim());
    }
  }
  return { selector, atContext, path };
}

/**
 * Create the property at the leaf of a nesting PATH, building/reusing each level so
 * the embed gets real nested source (`.hero { @container (…) { .title { prop } } }`).
 * A path whose leaf is an at-rule styles the ENCLOSING selector via an `& { }` rule.
 */
export function createNestedRule(region: StyleRegion, path: NestStep[], prop: string, declared: DeclarationValue): boolean {
  if (!region.root || !path.length) {
    return false;
  }
  const cleanProp = prop.trim();
  const cleanValue = declared.value.trim();
  if (!cleanProp || !cleanValue) {
    return false;
  }
  let container: Root | Rule | AtRule = region.root;
  for (const step of path) {
    const level = findOrMakeStep(container, step);
    if (level.created) {
      container.append(level.node);
      if (container.type !== 'root') {
        placeChild(container, level.node);
      }
    }
    container = level.node;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    return false;
  }
  if (container.type === 'rule') {
    assert(leaf.kind === 'selector', 'createNestedRule: a selector step builds a rule');
    appendDecl(container, cleanProp, { value: cleanValue, important: declared.important });
    container.raws.semicolon = true;
    return true;
  }
  assert(container.type === 'atrule', 'createNestedRule: a query step builds an at-rule');
  // Leaf is a query → the property styles the enclosing selector as a BARE declaration
  // inside the query (no `& { }` wrapper), placed above any nested rules.
  setDeclDirect(container, cleanProp, { value: cleanValue, important: declared.important });
  return true;
}

// The child of `container` for one nesting step, reused when present; otherwise a new,
// detached node — the caller decides where it is attached.
function findOrMakeStep(container: Root | Rule | AtRule, step: NestStep): { readonly node: Rule | AtRule; readonly created: boolean } {
  if (step.kind === 'selector') {
    const found = childRule(container, (rule) => squash(rule.selector) === squash(step.selector));
    return found ? { node: found, created: false } : { node: postcss.rule({ selector: step.selector }), created: true };
  }
  const found = childAtRule(container, step.name, step.params);
  return found ? { node: found, created: false } : { node: postcss.atRule({ name: step.name, params: step.params }), created: true };
}

/**
 * Where a query block is written: at the top level of the stylesheet, or nested
 * inside rules. `wrapper` is the selector those rules resolve to (every enclosing
 * rule, across any queries between them: resolveSelectorChain), the selector an
 * element must match, or sit inside, for the block to reach it.
 */
export type BlockPlacement = { readonly kind: 'top-level' } | { readonly kind: 'nested'; readonly wrapper: string };

/** A conditional at-rule block (@media/@container/@supports) available to scaffold into. */
export type AtRuleBlock = {
  /** The at-rule chain to (and including) this block, e.g. `['@container (width < 52em)']`. */
  atContext: string[];
  /** Live postcss node — append new rules here. */
  node: AtRule;
  /** Selectors of the rules already directly inside this block. */
  selectors: string[];
  /** Whether the block is nested inside rules, and which. */
  placement: BlockPlacement;
};

/**
 * List every conditional at-rule block in a region (nesting-aware), each with the
 * selectors already inside it. Used to offer "add a rule here" scaffolds for the
 * selected element without hand-writing the query wrapper.
 */
export function listAtRuleBlocks(region: StyleRegion): AtRuleBlock[] {
  if (!region.root) {
    return [];
  }
  const blocks: AtRuleBlock[] = [];

  // `enclosing` is the raw selectors of the rules around `container`, outermost first.
  const walk = (container: Root | Rule | AtRule, atContext: string[], enclosing: readonly string[], depth: number) => {
    // A stylesheet is untrusted input: blocks nested deeper than a page tree can be are
    // not offered, rather than walked without bound.
    if (depth > LIMITS.treeDepthMax) {
      return;
    }
    container.each((child: ChildNode) => {
      if (child.type === 'rule') {
        // Descend into nested rules — a @media/@container nested inside a rule is a
        // real query the element can be styled in, so it belongs in the picker.
        walk(child, atContext, [...enclosing, child.selector.trim()], depth + 1);
        return;
      }
      if (child.type !== 'atrule') {
        return;
      }
      const at = child as AtRule;
      const name = at.name.toLowerCase();
      if (name === 'media' || name === 'supports' || name === 'container') {
        const blockContext = [...atContext, `@${at.name} ${at.params}`.trim()];
        const selectors: string[] = [];
        at.each((node) => {
          if (node.type === 'rule') {
            selectors.push((node as Rule).selector.trim());
          }
        });
        const wrapper = resolveSelectorChain(enclosing);
        const placement: BlockPlacement = wrapper.length === 0 ? { kind: 'top-level' } : { kind: 'nested', wrapper };
        blocks.push({ atContext: blockContext, node: at, selectors, placement });
        walk(at, blockContext, enclosing, depth + 1);
      } else if (name === 'layer' && at.nodes) {
        walk(at, atContext, enclosing, depth + 1);
      }
    });
  };

  walk(region.root, [], [], 0);
  return blocks;
}

// Append a NEW top-level node to the region root, keeping it on its own line. A fresh
// (empty) region has no sibling for postcss to infer spacing from, so it renders the
// first child flush against the `<style>` tag (`<style>@media …`); force a leading
// newline in that case. Non-empty roots already infer a `\n` before from siblings.
function appendTopLevel(root: Root, node: ChildNode): void {
  const wasEmpty = !root.nodes || root.nodes.length === 0;
  const previous = blockRaws(root.last);
  root.append(node);
  if (wasEmpty) {
    node.assign({ raws: { ...node.raws, before: '\n' } });
    return;
  }
  // PostCSS indents a new rule's opening line and closing brace by nesting
  // depth, and a top-level rule has none, so in an indented <style> block a
  // new rule landed at column 0. The rule before it shows how this block lays
  // out its rules; a new one follows it.
  if (previous === undefined) {
    return;
  }
  if (node.type === 'rule' || node.type === 'atrule') {
    node.assign({ raws: { ...node.raws, before: previous.before, after: previous.after } });
  }
}

// The whitespace around a block (before its selector, before its closing brace),
// when the node is a block that has both.
function blockRaws(node: ChildNode | undefined): { readonly before: string; readonly after: string } | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.type !== 'rule' && node.type !== 'atrule') {
    return undefined;
  }
  const { before, after } = node.raws;
  if (before === undefined || after === undefined) {
    return undefined;
  }
  return { before, after };
}

/** Create `selector { prop: value }` inside an at-rule block. Returns false on empty input. */
export function createRuleInAtRule(atRule: AtRule, selector: string, prop: string, declared: DeclarationValue): boolean {
  const cleanProp = prop.trim();
  const cleanValue = declared.value.trim();
  if (!cleanProp || !cleanValue) {
    return false;
  }
  // Merge into an existing rule for this selector inside the block, else append a new one.
  const existing = findChildRuleBySelector(atRule, selector);
  if (existing) {
    setDeclOnRule(existing, cleanProp, { value: cleanValue, important: declared.important });
    return true;
  }
  // A new rule is attached and lined up before it gets its declaration, so the
  // declaration indents one step past the rule's own line. Left detached, PostCSS
  // guessed both from the first declaration in the stylesheet times the nesting
  // depth, and inside an indented, nested query that ran the body far right.
  const rule = postcss.rule({ selector });
  atRule.append(rule);
  placeChild(atRule, rule);
  setDeclOnRule(rule, cleanProp, { value: cleanValue, important: declared.important });
  placeNewRuleBody(rule);
  return true;
}

// Line up every child of a rule this module just created one indent step past
// the rule's own line. Only a new rule's body is touched, so the author's own
// rules keep their formatting.
function placeNewRuleBody(rule: Rule): void {
  assert(rule.parent !== undefined, 'placeNewRuleBody: the rule is attached');
  const children = rule.nodes ?? [];
  assert(children.length <= LIMITS.treeNodesMax, "placeNewRuleBody: the rule's body is bounded");
  for (const child of children) {
    placeChild(rule, child);
  }
}

/**
 * Create `selector { prop: value }` inside an `@media (params)` block, reusing an
 * existing equivalent block when present or appending a new one. Used to write a
 * value at a Webflow breakpoint that the embed doesn't yet have a query for.
 */
export function createRuleInMedia(region: StyleRegion, params: string, selector: string, prop: string, declared: DeclarationValue): boolean {
  if (!region.root) {
    return false;
  }
  const want = squash(params);
  const matching: AtRule[] = [];
  region.root.walkAtRules('media', (atRule) => {
    if (squash(atRule.params) === want) {
      matching.push(atRule);
    }
  });
  let target = matching[0];
  if (!target) {
    target = postcss.atRule({ name: 'media', params });
    appendTopLevel(region.root, target);
  }
  return createRuleInAtRule(target, selector, prop, declared);
}

/**
 * Create `selector { prop: value }` inside a query given by its joined context key
 * (`@container (width < 50em)`, or a ` › `-joined chain), reusing existing matching
 * at-rule blocks and creating any missing ones. Generalizes createRuleInMedia to
 * arbitrary @media/@container/@supports the user typed in the add-selector field.
 */
export function createRuleInQuery(region: StyleRegion, atContextKey: string, selector: string, prop: string, declared: DeclarationValue): boolean {
  if (!region.root) {
    return false;
  }
  const container = ensureQueryChain(region.root, querySegments(atContextKey));
  if (container === undefined || container.type === 'root') {
    return false; // not a query, or no query segment
  }
  return createRuleInAtRule(container, selector, prop, declared);
}

/**
 * Write `prop` for `selector` into a query nested inside `wrapper`
 * (`.button { @media (width < 50rem) { … } }`), the block a nested style
 * context names. Inside that block every selector is already relative to the
 * wrapper, so:
 *
 * - the wrapper itself is styled by a bare declaration in the query, the form
 *   css.ts reads back as the wrapper's own rule there (a `.button { }` written
 *   inside would mean `.button .button`, and style nothing);
 * - a selector written under the wrapper (`.button .icon`) loses that prefix;
 * - anything else is written as a nested rule, a descendant of the wrapper.
 *
 * The block is found by its query chain and its placement; when the region has
 * none, the wrapper and the chain are built at the top level. Returns false on
 * an empty property or value, or a region with no parsed tree.
 */
export function createRuleInPlacedQuery(
  region: StyleRegion,
  where: { readonly atContextKey: string; readonly wrapper: string; readonly selector: string },
  prop: string,
  declared: DeclarationValue,
): boolean {
  if (!region.root || !prop.trim() || !declared.value.trim()) {
    return false;
  }
  const wrapper = collapseSpaces(where.wrapper);
  const selector = collapseSpaces(where.selector);
  assert(wrapper.length > 0, 'createRuleInPlacedQuery: a nested query has a wrapper');
  const block = listAtRuleBlocks(region).find(
    (entry) => entry.atContext.join(' › ') === where.atContextKey && entry.placement.kind === 'nested' && entry.placement.wrapper === wrapper,
  );
  const inner = selector === wrapper ? undefined : selector.startsWith(`${wrapper} `) ? selector.slice(wrapper.length + 1) : selector;
  if (block !== undefined) {
    if (inner === undefined) {
      setDeclDirect(block.node, prop.trim(), { value: declared.value.trim(), important: declared.important });
      return true;
    }
    return createRuleInAtRule(block.node, inner, prop, declared);
  }
  const steps: NestStep[] = [{ kind: 'selector', selector: wrapper }];
  for (const segment of querySegments(where.atContextKey)) {
    const query = splitQuery(segment);
    if (query === undefined) {
      return false;
    }
    steps.push({ kind: 'atrule', name: query.name.toLowerCase(), params: query.params });
  }
  if (inner !== undefined) {
    steps.push({ kind: 'selector', selector: inner });
  }
  assert(steps.length >= 2, 'createRuleInPlacedQuery: a wrapper and at least one query');
  return createNestedRule(region, steps, prop, declared);
}

function collapseSpaces(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// The ` › `-joined segments of a query context key.
function querySegments(atContextKey: string): string[] {
  return atContextKey
    .split('›')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// Walk (building what is missing) the at-rule chain for `segments` from `root`, and
// return the innermost block — `root` itself for no segments, undefined when a segment
// is not an at-rule.
function ensureQueryChain(root: Root, segments: readonly string[]): Root | AtRule | undefined {
  let container: Root | AtRule = root;
  for (const segment of segments) {
    const match = /^@(\w+)\s*([\s\S]*)$/.exec(segment);
    if (!match) {
      return undefined;
    }
    const name = (match[1] ?? '').toLowerCase();
    const params = (match[2] ?? '').trim();
    let found = childAtRule(container, name, params);
    if (!found) {
      found = postcss.atRule({ name, params });
      if (container.type === 'root') {
        appendTopLevel(container, found);
      } else {
        // Lined up one step inside its parent query, as a new nested rule is.
        container.append(found);
        placeChild(container, found);
      }
    }
    container = found;
  }
  return container;
}

/**
 * Create `selector { prop: value }` at the region root (base, non-@ level). Returns false on
 * empty input.
 */
export function createRuleAtRoot(region: StyleRegion, selector: string, prop: string, declared: DeclarationValue): boolean {
  if (!region.root) {
    return false;
  }
  const cleanProp = prop.trim();
  const cleanValue = declared.value.trim();
  if (!cleanProp || !cleanValue) {
    return false;
  }
  // Merge into an existing top-level rule for this selector, else append a new one — so
  // adding a selector that the embed already has extends that rule instead of duplicating it.
  const existing = findChildRuleBySelector(region.root, selector);
  if (existing) {
    setDeclOnRule(existing, cleanProp, { value: cleanValue, important: declared.important });
    return true;
  }
  // Attached first, as in createRuleInAtRule, so the body indents from the rule's line.
  const rule = postcss.rule({ selector });
  appendTopLevel(region.root, rule);
  setDeclOnRule(rule, cleanProp, { value: cleanValue, important: declared.important });
  placeNewRuleBody(rule);
  return true;
}

/**
 * Ensure the conditional at-rule block(s) for a query context key exist in the region,
 * creating an EMPTY `@media (…) {}` (nesting-aware, reusing existing blocks) with no rule
 * inside. Lets a just-added query land in the embed source immediately, before any
 * property is written into it. Returns false for an empty key or missing root.
 */
export function ensureQueryBlock(region: StyleRegion, atContextKey: string): boolean {
  const root = region.root;
  if (!root) {
    return false;
  }
  const segments = querySegments(atContextKey);
  if (!segments.length) {
    return false;
  }
  return ensureQueryChain(root, segments) !== undefined;
}

/**
 * Build (or reuse) every level of a typed nesting PATH without writing any declaration —
 * scaffolds `selector { @query {} }` (empty) so a query nested under a selector lands in
 * the embed source immediately, before any property is applied. Returns false on an
 * empty path or missing root.
 */
export function ensureNestPath(region: StyleRegion, path: NestStep[]): boolean {
  const root = region.root;
  if (!root || !path.length) {
    return false;
  }
  let container: Root | Rule | AtRule = root;
  for (const step of path) {
    const level = findOrMakeStep(container, step);
    if (level.created) {
      if (container === root) {
        appendTopLevel(root, level.node);
      } else if (container.type !== 'root') {
        container.append(level.node);
        placeChild(container, level.node);
      }
    }
    container = level.node;
  }
  return true;
}

function buildRule(
  node: Rule,
  atContext: string[],
  context: WalkContext,
  index: number,
  resolvedSelectors?: string[],
  nestedDisplay?: string,
  queryDisplay?: string,
): ParsedRule {
  const ruleId = `${context.idSeed}:${context.regionIndex}:${index}`;
  const declarations: ParsedDeclaration[] = [];
  let declCounter = 0;
  node.each((child) => {
    if (child.type === 'decl') {
      declarations.push({
        declId: `${ruleId}:d${declCounter++}`,
        prop: child.prop.trim().toLowerCase(),
        value: child.value.trim(),
        important: child.important === true,
        node: child,
      });
    }
  });

  // A nested rule matches/displays by its selector RESOLVED against the parent; the
  // postcss node keeps the raw nested selector (`.hero_title`) for editing.
  const selectorText = resolvedSelectors && resolvedSelectors.length ? resolvedSelectors.join(', ') : node.selector;
  const parents = ruleChainLevels(node);

  return {
    ruleId,
    order: context.order.n++,
    embedKey: context.embedKey,
    embedLabel: context.embedLabel,
    fromComponent: context.fromComponent,
    componentName: context.componentName,
    regionIndex: context.regionIndex,
    node,
    selectorText,
    ...(nestedDisplay === undefined ? {} : { nestedDisplay }),
    ...(queryDisplay === undefined ? {} : { queryDisplay }),
    ...(parents.length === 0 ? {} : { written: { parents, head: ruleHead(node) } }),
    atContext,
    selectors: parseSelectorList(selectorText),
    declarations,
  };
}

/** Remove a declaration from its rule. */
export function removeDeclaration(decl: ParsedDeclaration) {
  decl.node.remove();
}

/** Remove an entire rule from its stylesheet. */
export function removeRule(rule: ParsedRule) {
  rule.node.remove();
}

/**
 * Split the `index`-th selector out of a grouped rule (`a, b, c { … }`) into its own
 * new rule, cloning all declarations, inserted right after the original. The original
 * keeps its other selectors. Returns the new rule node so the caller can edit it in
 * isolation — so an edit to `.a` no longer touches `.b`/`.c`. Undefined when the rule
 * isn't grouped or the index is out of range.
 */
export function splitRuleSelectorAt(node: Rule, index: number): Rule | undefined {
  const selectors = node.selectors;
  if (index < 0 || index >= selectors.length || selectors.length <= 1) {
    return undefined;
  }
  const clone = node.clone();
  clone.selector = selectors[index] ?? '';
  // Ensure the new rule starts on its own line (clone inherits the original's
  // leading whitespace, which may be empty for the first rule → `}.a {`).
  if (!clone.raws.before?.includes('\n')) {
    clone.raws.before = `\n${clone.raws.before ?? ''}`;
  }
  node.assign({ selectors: selectors.filter((_, i) => i !== index) });
  node.parent?.insertAfter(node, clone);
  return clone;
}

/**
 * Remove a rule once it holds no declarations — so clearing the last property
 * from a selector drops the now-empty selector from the custom code instead of
 * leaving `.foo {}` behind. Comments don't count as content. Returns true when
 * the rule was removed.
 */
export function removeRuleIfEmpty(rule: ParsedRule): boolean {
  let hasDeclaration = false;
  let hasNested = false;
  rule.node.each((node) => {
    if (node.type === 'decl') {
      hasDeclaration = true;
    } else if (node.type === 'rule' || node.type === 'atrule') {
      hasNested = true;
    }
  });
  // Keep the rule if it still holds declarations OR nested rules (a nested-CSS
  // parent whose own last property was just cleared but that still wraps children).
  if (hasDeclaration || hasNested) {
    return false;
  }
  rule.node.remove();
  return true;
}

/** Append a new declaration to a rule. Returns false on invalid input. */
export function addDeclaration(rule: ParsedRule, prop: string, declared: DeclarationValue): boolean {
  const cleanProp = prop.trim();
  const cleanValue = declared.value.trim();
  if (!cleanProp || !cleanValue) {
    return false;
  }
  appendDecl(rule.node, cleanProp, { value: cleanValue, important: declared.important });
  return true;
}

/**
 * Reorder a rule's declarations to match `orderedDeclIds`. Detaches the decl
 * nodes and re-appends them in the requested order (non-declaration nodes like
 * comments keep their relative position at the front).
 */
export function reorderDeclarations(rule: ParsedRule, orderedDeclIds: string[]) {
  const byId = new Map(rule.declarations.map((declaration) => [declaration.declId, declaration.node]));
  const nodes = orderedDeclIds.map((id) => byId.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node));
  nodes.forEach((node) => node.remove());
  nodes.forEach((node) => rule.node.append(node));
}

/**
 * Replace a rule's entire body by re-parsing the CSS Code editor's text for that rule.
 * The editor shows the rule flush left with a tab per level (ruleEditorText); the
 * block's indentation and the file's own indent unit go back before parsing, and the
 * rule keeps the whitespace that led up to it, so the file keeps its layout.
 */
export function replaceRuleCss(rule: ParsedRule, editorCss: string): { ok: true } | Failure {
  const before = rule.node.raws.before;
  const sourceCss = sourceTextFromEditor(editorCss, ruleLayout(rule.node));
  try {
    const parsed = postcss.parse(sourceCss);
    // A nested query's own declarations are a rule bound to the at-rule itself.
    const nodes = parsed.nodes.filter((node) => node.type === rule.node.type);
    if (!nodes.length) {
      return failureOf('styleModel.css.noRule');
    }
    const first = parsed.first;
    assert(first !== undefined, 'replaceRuleCss: a parse with a rule has a first node');
    if (before !== undefined) {
      first.assign({ raws: { ...first.raws, before } });
    }
    rule.node.replaceWith(...parsed.nodes);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

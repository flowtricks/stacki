// CSS parsing and write-back for embed `<style>` blocks.
//
// Strategy: we hold the live postcss Root for each `<style>` region. Reads flow
// from the parsed tree; edits mutate AST nodes in place and re-stringify only
// the affected region, splicing it back into the embed code string. postcss
// preserves the original formatting (`raws`) of untouched nodes, so an edit to
// one value never reflows the rest of the author's code.

import postcss, { type Root, type Rule, type AtRule, type ChildNode, type Declaration } from 'postcss'
import type { ParsedDeclaration, ParsedRule, StyleRegion } from './types'
import { parseSelectorList } from './selectors'
import { selectorKey } from './resolved'

// A direct child rule of `container` whose selector is the SAME target as `selector`
// (by selectorKey, so `.a.b` === `.b.a`) — used to merge into an existing rule rather
// than appending a duplicate. Only direct children (not nested) so a flat add stays flat.
function findChildRuleBySelector(container: Root | AtRule, selector: string): Rule | null {
  const key = selectorKey(selector)
  let found: Rule | null = null
  container.each((child) => {
    if (!found && child.type === 'rule' && selectorKey((child as Rule).selector) === key) found = child as Rule
  })
  return found
}

// Update the rule's existing declaration for `prop`, or append it — mirrors onSetProp.
function setDeclOnRule(rule: Rule, prop: string, value: string, important: boolean) {
  let decl: Declaration | null = null
  rule.walkDecls(prop, (found) => { decl = found })
  if (decl) { (decl as Declaration).value = value; (decl as Declaration).important = important }
  else rule.append({ prop, value, important })
  // Terminate the last declaration with `;` (postcss omits it unless this is set).
  rule.raws.semicolon = true
}

const STYLE_OPEN = /<style\b[^>]*>/gi
const STYLE_CLOSE = '</style>'

/** Locate every `<style>...</style>` region and capture its inner CSS + offsets. */
export function extractStyleRegions(code: string): StyleRegion[] {
  const regions: StyleRegion[] = []
  const lower = code.toLowerCase()
  STYLE_OPEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = STYLE_OPEN.exec(code))) {
    const innerStart = match.index + match[0].length
    const closeIdx = lower.indexOf(STYLE_CLOSE, innerStart)
    if (closeIdx === -1) break
    regions.push({
      start: innerStart,
      end: closeIdx,
      css: code.slice(innerStart, closeIdx),
      root: null,
      openTag: match[0],
    })
    STYLE_OPEN.lastIndex = closeIdx + STYLE_CLOSE.length
  }
  return regions
}

/** Parse a region's CSS into a postcss Root, recording any parse error. */
export function parseRegion(region: StyleRegion): Root | null {
  try {
    region.root = postcss.parse(region.css)
    delete region.parseError
  } catch (error) {
    region.root = null
    region.parseError = error instanceof Error ? error.message : String(error)
  }
  return region.root
}

/** Re-stringify a region's root and splice it back into the full embed code. */
export function applyRegionToCode(code: string, region: StyleRegion): string {
  if (!region.root) return code
  const css = region.root.toString()
  const next = code.slice(0, region.start) + css + code.slice(region.end)
  // Keep the region offsets/css consistent after the splice so further edits land.
  region.end = region.start + css.length
  region.css = css
  return next
}

/**
 * Split an embed into immutable HTML segments interleaved with style regions.
 * `segments` has `regions.length + 1` entries: the literal code before each
 * region's inner CSS (including the `<style…>`/`</style>` tags) and the trailing
 * code. Rebuilding from segments avoids any offset bookkeeping across edits.
 */
export function splitEmbed(code: string): { segments: string[]; regions: StyleRegion[] } {
  const regions = extractStyleRegions(code)
  const segments: string[] = []
  let cursor = 0
  for (const region of regions) {
    segments.push(code.slice(cursor, region.start))
    cursor = region.end
  }
  segments.push(code.slice(cursor))
  return { segments, regions }
}

/** Reconstruct embed code by interleaving static segments with region roots. */
export function renderEmbed(segments: string[], regions: StyleRegion[]): string {
  let out = segments[0] ?? ''
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i]
    out += region.root ? region.root.toString() : region.css
    out += segments[i + 1] ?? ''
  }
  return out
}

type WalkContext = {
  embedKey: string
  embedLabel: string
  fromComponent: boolean
  componentName: string | null
  regionIndex: number
  idSeed: string
  /** Shared running counter assigning cascade document order across embeds. */
  order: { n: number }
}

/** Split a selector list on top-level commas (ignoring commas inside `()`/`[]`). */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = []
  let paren = 0
  let bracket = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === '(') paren += 1
    else if (c === ')') paren = Math.max(0, paren - 1)
    else if (c === '[') bracket += 1
    else if (c === ']') bracket = Math.max(0, bracket - 1)
    else if (c === ',' && paren === 0 && bracket === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) parts.push(last)
  return parts.filter(Boolean)
}

/** Combine one parent selector with one nested selector per CSS nesting rules:
 *  `&` is replaced by the parent; otherwise the parent is prepended (so `.b` →
 *  `parent .b` and a leading combinator `> .b` → `parent > .b`). */
function combineNesting(parent: string, sel: string): string {
  const s = sel.trim()
  if (s.includes('&')) return s.replace(/&/g, parent)
  return `${parent} ${s}`
}

/** Resolve a nested rule's selector list against its parent's resolved selectors —
 *  the cartesian product, so grouped parents/children expand correctly. */
function resolveNestedSelectors(rawSelector: string, parents: string[]): string[] {
  const nested = splitTopLevelCommas(rawSelector)
  const out: string[] = []
  for (const parent of parents) {
    for (const sel of nested) out.push(combineNesting(parent, sel))
  }
  return out
}

/**
 * Flatten a region's root into ParsedRule[], resolving native CSS nesting. A rule
 * nested inside another is combined with its parent's selector (`&` replaced, or
 * the parent prepended as a descendant/combinator); nested `@media`/`@container`/
 * `@supports` carry their condition into `atContext`. Each nested rule keeps its
 * live postcss node, so it stays editable. Unknown at-rules (`@keyframes`, …) are
 * skipped so their inner rules don't masquerade as page styles.
 *
 * A nested at-rule's OWN bare declarations (styling the enclosing selector within the
 * query, e.g. `.a { @container { color: red } }`) are surfaced as a rule bound to the
 * at-rule node itself — no `& { }` wrapper — so the authored bare form round-trips and
 * both bare and explicit `& { }` inputs read the same.
 */

/** The DIRECT declaration children of a rule/at-rule node — excludes any declarations
 *  belonging to nested rules, so editing a nesting parent never touches its children. */
export function directDecls(node: Rule | AtRule): Declaration[] {
  const out: Declaration[] = []
  node.each((child) => { if (child.type === 'decl') out.push(child as Declaration) })
  return out
}

/** Append a declaration, placing it before any nested rules so a parent's own decls stay
 *  grouped above its nested rules (e.g. bare decls at the top of a query block). */
export function appendDecl(node: Rule | AtRule, prop: string, value: string, important: boolean): Declaration {
  const decl = postcss.decl({ prop, value, important })
  let firstNested: ChildNode | null = null
  node.each((child) => {
    if (!firstNested && (child.type === 'rule' || child.type === 'atrule')) firstNested = child as ChildNode
  })
  if (firstNested) node.insertBefore(firstNested, decl)
  else node.append(decl)
  // Terminate the last declaration with `;` (postcss omits it unless this is set).
  node.raws.semicolon = true
  return decl
}

/** Set (update-or-append) a DIRECT declaration on a node — scoped so a nested rule's
 *  declaration of the same prop is never mistaken for this node's own. */
function setDeclDirect(node: Rule | AtRule, prop: string, value: string, important: boolean) {
  const key = prop.trim().toLowerCase()
  const existing = directDecls(node).find((d) => d.prop.trim().toLowerCase() === key)
  if (existing) { existing.value = value; existing.important = important; node.raws.semicolon = true }
  else appendDecl(node, prop, value, important)
}

/** Render a chain of SELECTOR ancestors as nested source for display, e.g.
 *  `['.hero', '.title']` → `.hero { .title }`. Queries aren't included (they show in
 *  the context dropdown), so a nested chip reads as the code the user is editing. */
function renderNestedPath(parts: string[], isRoot = true): string {
  if (!parts.length) return ''
  const [head, ...rest] = parts
  if (head === '@') return rest.length ? `@ ${renderNestedPath(rest, false)}` : '@'
  const restStr = renderNestedPath(rest, false)
  // Braces when this selector wraps another selector, or when it's the outermost
  // selector with content (e.g. its own decls sit in a nested query → `.hero {@}`).
  // A nested selector whose only content is a query stays inline (`.title @`).
  if (rest.some((p) => p !== '@') || (isRoot && rest.length)) return `${head} {${restStr}}`
  return restStr ? `${head} ${restStr}` : head
}

export function collectRules(region: StyleRegion, ctx: WalkContext): ParsedRule[] {
  if (!region.root) return []
  const rules: ParsedRule[] = []
  let ruleCounter = 0

  // parentSelectors: null at the top level; the enclosing rule's RESOLVED selectors
  // once inside one. ancestorDisplay: the enclosing rules' RAW selectors plus `@`
  // markers for enclosing queries, in order, for the nested display.
  const walk = (
    container: Root | Rule | AtRule,
    atContext: string[],
    parentSelectors: string[] | null,
    ancestorDisplay: string[],
  ) => {
    container.each((child: ChildNode) => {
      if (child.type === 'rule') {
        const node = child as Rule
        const raw = node.selector.trim()
        const resolved = parentSelectors ? resolveNestedSelectors(node.selector, parentSelectors) : null
        // Display path: enclosing selectors + `@` query markers. `&` collapses to the
        // parent (its decls belong to the enclosing selector).
        const displayPath = raw === '&' ? ancestorDisplay : [...ancestorDisplay, raw]
        const selectorsOnly = displayPath.filter((p) => p !== '@')
        // nestedDisplay: selector nesting only (Base view). queryDisplay: with `@` at
        // the query position (shown when viewing that query).
        const nestedDisplay = selectorsOnly.length > 1 ? renderNestedPath(selectorsOnly) : undefined
        const queryDisplay = displayPath.includes('@') ? renderNestedPath(displayPath) : undefined
        rules.push(buildRule(node, atContext, ctx, ruleCounter++, resolved, nestedDisplay, queryDisplay))
        walk(node, atContext, resolved ?? splitTopLevelCommas(node.selector), displayPath)
      } else if (child.type === 'atrule') {
        const at = child as AtRule
        const name = at.name.toLowerCase()
        // Conditional group at-rules wrap element styles that apply under a condition —
        // descend, carry the condition into the cascade context, and mark the query
        // position (`@`) in the display path so the chip can show WHERE the query sits.
        if (name === 'media' || name === 'supports' || name === 'container') {
          const nextCtx = [...atContext, `@${at.name} ${at.params}`.trim()]
          const nextDisplay = [...ancestorDisplay, '@']
          // A nested query's OWN bare declarations style the ENCLOSING selector within
          // the query. Surface them as a rule bound to the at-rule node itself (its
          // direct decls), so the authored bare form round-trips without an `& { }`.
          if (parentSelectors && parentSelectors.length && at.some((n) => n.type === 'decl')) {
            const selectorsOnly = nextDisplay.filter((p) => p !== '@')
            const nestedDisplay = selectorsOnly.length > 1 ? renderNestedPath(selectorsOnly) : undefined
            const queryDisplay = renderNestedPath(nextDisplay)
            rules.push(buildRule(at as unknown as Rule, nextCtx, ctx, ruleCounter++, parentSelectors, nestedDisplay, queryDisplay))
          }
          walk(at, nextCtx, parentSelectors, nextDisplay)
        } else if (name === 'layer' && at.nodes) {
          walk(at, atContext, parentSelectors, ancestorDisplay)
        }
        // @keyframes / @font-face / @import etc. inject no element styles — skip.
      }
    })
  }

  walk(region.root, [], null, [])
  return rules
}

/**
 * Parse a selector typed in the "add a selector" field that uses CSS nesting and/or a
 * query — e.g. `.hero { .title }`, `.hero { @container (width < 50em) { .title } }`, or
 * `.hero { @container (width < 50em) }`. Returns the DEEPEST resolved selector and its
 * at-rule (query) context, or null when unparseable. A flat selector (no braces) is
 * left for the caller to use as-is.
 */
/** One step of a typed nesting path: a selector level or a query (at-rule) level. */
export type NestStep =
  | { kind: 'selector'; selector: string }
  | { kind: 'atrule'; name: string; params: string }

export function parseNestedInput(
  input: string,
): { selector: string; atContext: string[]; path: NestStep[] } | null {
  const text = input.trim()
  if (!text) return null
  // The add-selector field holds selectors/queries only (no declarations), so any
  // bare selector/at-rule sitting directly before a `}` needs a block for postcss to
  // parse the nesting — give it an empty one (`.hero { .title }` → `.hero { .title {} }`).
  const normalized = text.replace(/([^{}]+?)\s*\}/g, (_m, content) => {
    const c = String(content).trim()
    return c ? `${c} {} }` : ' }'
  })
  let root: Root
  try {
    root = postcss.parse(normalized)
  } catch {
    return null
  }
  // Follow the single deepest branch (first rule/query child at each level).
  const path: NestStep[] = []
  const QUERY_ATS = new Set(['media', 'container', 'supports'])
  let container: Root | Rule | AtRule = root
  for (;;) {
    const children: ChildNode[] = []
    container.each((child: ChildNode) => { children.push(child) })
    const next = children.find(
      (c) => c.type === 'rule' || (c.type === 'atrule' && QUERY_ATS.has((c as AtRule).name.toLowerCase())),
    )
    if (!next) break
    if (next.type === 'rule') {
      path.push({ kind: 'selector', selector: (next as Rule).selector.trim() })
      container = next as Rule
    } else {
      const at = next as AtRule
      path.push({ kind: 'atrule', name: at.name.toLowerCase(), params: at.params.trim() })
      container = at
    }
  }
  if (!path.length) return null
  // Derive the resolved selector + query context from the path.
  let selector = ''
  const atContext: string[] = []
  for (const step of path) {
    if (step.kind === 'selector') {
      const first = splitTopLevelCommas(step.selector)[0] ?? step.selector
      selector = selector ? combineNesting(selector, first) : first
    } else {
      atContext.push(`@${step.name} ${step.params}`.trim())
    }
  }
  return { selector, atContext, path }
}

/**
 * Create the property at the leaf of a nesting PATH, building/reusing each level so
 * the embed gets real nested source (`.hero { @container (…) { .title { prop } } }`).
 * A path whose leaf is an at-rule styles the ENCLOSING selector via an `& { }` rule.
 */
export function createNestedRule(
  region: StyleRegion,
  path: NestStep[],
  prop: string,
  value: string,
  important: boolean,
): boolean {
  if (!region.root || !path.length) return false
  const cleanProp = prop.trim()
  const cleanValue = value.trim()
  if (!cleanProp || !cleanValue) return false
  const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase()
  let container: Root | Rule | AtRule = region.root
  for (const step of path) {
    if (step.kind === 'selector') {
      let found: Rule | null = null
      container.each((n) => {
        if (!found && n.type === 'rule' && norm((n as Rule).selector) === norm(step.selector)) found = n as Rule
      })
      if (!found) {
        found = postcss.rule({ selector: step.selector })
        container.append(found)
      }
      container = found
    } else {
      let found: AtRule | null = null
      container.each((n) => {
        if (!found && n.type === 'atrule'
          && (n as AtRule).name.toLowerCase() === step.name
          && norm((n as AtRule).params) === norm(step.params)) found = n as AtRule
      })
      if (!found) {
        found = postcss.atRule({ name: step.name, params: step.params })
        container.append(found)
      }
      container = found
    }
  }
  const leaf = path[path.length - 1]
  if (leaf.kind === 'selector') {
    ;(container as Rule).append({ prop: cleanProp, value: cleanValue, important })
    ;(container as Rule).raws.semicolon = true
    return true
  }
  // Leaf is a query → the property styles the enclosing selector as a BARE declaration
  // inside the query (no `& { }` wrapper), placed above any nested rules.
  setDeclDirect(container as AtRule, cleanProp, cleanValue, important)
  return true
}

/** A conditional at-rule block (@media/@container/@supports) available to scaffold into. */
export type AtRuleBlock = {
  /** The at-rule chain to (and including) this block, e.g. `['@container (width < 52em)']`. */
  atContext: string[]
  /** Live postcss node — append new rules here. */
  node: AtRule
  /** Selectors of the rules already directly inside this block. */
  selectors: string[]
}

/**
 * List every conditional at-rule block in a region (nesting-aware), each with the
 * selectors already inside it. Used to offer "add a rule here" scaffolds for the
 * selected element without hand-writing the query wrapper.
 */
export function listAtRuleBlocks(region: StyleRegion): AtRuleBlock[] {
  if (!region.root) return []
  const blocks: AtRuleBlock[] = []

  const walk = (container: Root | Rule | AtRule, atContext: string[]) => {
    container.each((child: ChildNode) => {
      if (child.type === 'rule') {
        // Descend into nested rules — a @media/@container nested inside a rule is a
        // real query the element can be styled in, so it belongs in the picker.
        walk(child as Rule, atContext)
        return
      }
      if (child.type !== 'atrule') return
      const at = child as AtRule
      const name = at.name.toLowerCase()
      if (name === 'media' || name === 'supports' || name === 'container') {
        const ctx = [...atContext, `@${at.name} ${at.params}`.trim()]
        const selectors: string[] = []
        at.each((node) => { if (node.type === 'rule') selectors.push((node as Rule).selector.trim()) })
        blocks.push({ atContext: ctx, node: at, selectors })
        walk(at, ctx)
      } else if (name === 'layer' && at.nodes) {
        walk(at, atContext)
      }
    })
  }

  walk(region.root, [])
  return blocks
}

// Append a NEW top-level node to the region root, keeping it on its own line. A fresh
// (empty) region has no sibling for postcss to infer spacing from, so it renders the
// first child flush against the `<style>` tag (`<style>@media …`); force a leading
// newline in that case. Non-empty roots already infer a `\n` before from siblings.
function appendTopLevel(root: Root, node: ChildNode): void {
  const wasEmpty = !root.nodes || root.nodes.length === 0
  root.append(node)
  if (wasEmpty) node.raws.before = '\n'
}

/** Create `selector { prop: value }` inside an at-rule block. Returns false on empty input. */
export function createRuleInAtRule(
  atRule: AtRule,
  selector: string,
  prop: string,
  value: string,
  important: boolean,
): boolean {
  const cleanProp = prop.trim()
  const cleanValue = value.trim()
  if (!cleanProp || !cleanValue) return false
  // Merge into an existing rule for this selector inside the block, else append a new one.
  const existing = findChildRuleBySelector(atRule, selector)
  const rule = existing ?? postcss.rule({ selector })
  setDeclOnRule(rule, cleanProp, cleanValue, important)
  if (!existing) atRule.append(rule)
  return true
}

/**
 * Create `selector { prop: value }` inside an `@media (params)` block, reusing an
 * existing equivalent block when present or appending a new one. Used to write a
 * value at a Webflow breakpoint that the embed doesn't yet have a query for.
 */
export function createRuleInMedia(
  region: StyleRegion,
  params: string,
  selector: string,
  prop: string,
  value: string,
  important: boolean,
): boolean {
  if (!region.root) return false
  const norm = (text: string) => text.replace(/\s+/g, '').toLowerCase()
  const want = norm(params)
  let target: AtRule | null = null
  region.root.walkAtRules('media', (atRule) => {
    if (!target && norm(atRule.params) === want) target = atRule
  })
  if (!target) {
    target = postcss.atRule({ name: 'media', params })
    appendTopLevel(region.root, target)
  }
  return createRuleInAtRule(target, selector, prop, value, important)
}

/**
 * Create `selector { prop: value }` inside a query given by its joined context key
 * (`@container (width < 50em)`, or a ` › `-joined chain), reusing existing matching
 * at-rule blocks and creating any missing ones. Generalizes createRuleInMedia to
 * arbitrary @media/@container/@supports the user typed in the add-selector field.
 */
export function createRuleInQuery(
  region: StyleRegion,
  atContextKey: string,
  selector: string,
  prop: string,
  value: string,
  important: boolean,
): boolean {
  if (!region.root) return false
  const segments = atContextKey.split('›').map((seg) => seg.trim()).filter(Boolean)
  const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase()
  let container: Root | AtRule = region.root
  for (const seg of segments) {
    const m = /^@(\w+)\s*([\s\S]*)$/.exec(seg)
    if (!m) return false
    const name = m[1].toLowerCase()
    const params = m[2].trim()
    let found: AtRule | null = null
    container.each((n) => {
      if (!found && n.type === 'atrule'
        && (n as AtRule).name.toLowerCase() === name
        && norm((n as AtRule).params) === norm(params)) found = n as AtRule
    })
    if (!found) {
      found = postcss.atRule({ name, params })
      if (container === region.root) appendTopLevel(region.root, found)
      else container.append(found)
    }
    container = found
  }
  if (container === region.root) return false // no query segment
  return createRuleInAtRule(container as AtRule, selector, prop, value, important)
}

/** Create `selector { prop: value }` at the region root (base, non-@ level). Returns false on empty input. */
export function createRuleAtRoot(
  region: StyleRegion,
  selector: string,
  prop: string,
  value: string,
  important: boolean,
): boolean {
  if (!region.root) return false
  const cleanProp = prop.trim()
  const cleanValue = value.trim()
  if (!cleanProp || !cleanValue) return false
  // Merge into an existing top-level rule for this selector, else append a new one — so
  // adding a selector that the embed already has extends that rule instead of duplicating it.
  const existing = findChildRuleBySelector(region.root, selector)
  const rule = existing ?? postcss.rule({ selector })
  setDeclOnRule(rule, cleanProp, cleanValue, important)
  if (!existing) appendTopLevel(region.root, rule)
  return true
}

/**
 * Ensure the conditional at-rule block(s) for a query context key exist in the region,
 * creating an EMPTY `@media (…) {}` (nesting-aware, reusing existing blocks) with no rule
 * inside. Lets a just-added query land in the embed source immediately, before any
 * property is written into it. Returns false for an empty key or missing root.
 */
export function ensureQueryBlock(region: StyleRegion, atContextKey: string): boolean {
  const root = region.root
  if (!root) return false
  const segments = atContextKey.split('›').map((seg) => seg.trim()).filter(Boolean)
  if (!segments.length) return false
  const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase()
  let container: Root | AtRule = root
  for (const seg of segments) {
    const m = /^@(\w+)\s*([\s\S]*)$/.exec(seg)
    if (!m) return false
    const name = m[1].toLowerCase()
    const params = m[2].trim()
    let found: AtRule | null = null
    container.each((n) => {
      if (!found && n.type === 'atrule'
        && (n as AtRule).name.toLowerCase() === name
        && norm((n as AtRule).params) === norm(params)) found = n as AtRule
    })
    if (!found) {
      found = postcss.atRule({ name, params })
      if (container === root) appendTopLevel(root, found)
      else container.append(found)
    }
    container = found
  }
  return true
}

/**
 * Build (or reuse) every level of a typed nesting PATH without writing any declaration —
 * scaffolds `selector { @query {} }` (empty) so a query nested under a selector lands in
 * the embed source immediately, before any property is applied. Returns false on an
 * empty path or missing root.
 */
export function ensureNestPath(region: StyleRegion, path: NestStep[]): boolean {
  const root = region.root
  if (!root || !path.length) return false
  const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase()
  let container: Root | Rule | AtRule = root
  for (const step of path) {
    if (step.kind === 'selector') {
      let found: Rule | null = null
      container.each((n) => {
        if (!found && n.type === 'rule' && norm((n as Rule).selector) === norm(step.selector)) found = n as Rule
      })
      if (!found) {
        found = postcss.rule({ selector: step.selector })
        if (container === root) appendTopLevel(root, found)
        else container.append(found)
      }
      container = found
    } else {
      let found: AtRule | null = null
      container.each((n) => {
        if (!found && n.type === 'atrule'
          && (n as AtRule).name.toLowerCase() === step.name
          && norm((n as AtRule).params) === norm(step.params)) found = n as AtRule
      })
      if (!found) {
        found = postcss.atRule({ name: step.name, params: step.params })
        if (container === root) appendTopLevel(root, found)
        else container.append(found)
      }
      container = found
    }
  }
  return true
}

function buildRule(
  node: Rule,
  atContext: string[],
  ctx: WalkContext,
  index: number,
  resolvedSelectors?: string[] | null,
  nestedDisplay?: string,
  queryDisplay?: string,
): ParsedRule {
  const ruleId = `${ctx.idSeed}:${ctx.regionIndex}:${index}`
  const declarations: ParsedDeclaration[] = []
  let declCounter = 0
  node.each((child) => {
    if (child.type === 'decl') {
      declarations.push({
        declId: `${ruleId}:d${declCounter++}`,
        prop: child.prop.trim().toLowerCase(),
        value: child.value.trim(),
        important: child.important === true,
        node: child,
      })
    }
  })

  // A nested rule matches/displays by its selector RESOLVED against the parent; the
  // postcss node keeps the raw nested selector (`.hero_title`) for editing.
  const selectorText = resolvedSelectors && resolvedSelectors.length
    ? resolvedSelectors.join(', ')
    : node.selector

  return {
    ruleId,
    order: ctx.order.n++,
    embedKey: ctx.embedKey,
    embedLabel: ctx.embedLabel,
    fromComponent: ctx.fromComponent,
    componentName: ctx.componentName,
    regionIndex: ctx.regionIndex,
    node,
    selectorText,
    nestedDisplay,
    queryDisplay,
    atContext,
    selectors: parseSelectorList(selectorText),
    declarations,
  }
}

/** Update a declaration's value (and !important), keeping the AST in sync. */
export function setDeclarationValue(decl: ParsedDeclaration, value: string, important: boolean) {
  decl.node.value = value
  decl.node.important = important
  decl.value = value.trim()
  decl.important = important
  // Terminate the last declaration with `;` (postcss omits it unless this is set).
  const parent = decl.node.parent
  if (parent) (parent as Rule).raws.semicolon = true
}

/** Rename a declaration's property. */
export function setDeclarationProp(decl: ParsedDeclaration, prop: string) {
  decl.node.prop = prop.trim()
  decl.prop = prop.trim().toLowerCase()
}

/** Remove a declaration from its rule. */
export function removeDeclaration(decl: ParsedDeclaration) {
  decl.node.remove()
}

/** Remove an entire rule from its stylesheet. */
export function removeRule(rule: ParsedRule) {
  rule.node.remove()
}

/**
 * Split the `index`-th selector out of a grouped rule (`a, b, c { … }`) into its own
 * new rule, cloning all declarations, inserted right after the original. The original
 * keeps its other selectors. Returns the new rule node so the caller can edit it in
 * isolation — so an edit to `.a` no longer touches `.b`/`.c`. Null when the rule isn't
 * grouped or the index is out of range.
 */
export function splitRuleSelectorAt(node: Rule, index: number): Rule | null {
  const selectors = node.selectors
  if (index < 0 || index >= selectors.length || selectors.length <= 1) return null
  const clone = node.clone() as Rule
  clone.selector = selectors[index]
  // Ensure the new rule starts on its own line (clone inherits the original's
  // leading whitespace, which may be empty for the first rule → `}.a {`).
  if (!clone.raws.before?.includes('\n')) clone.raws.before = `\n${clone.raws.before ?? ''}`
  node.selectors = selectors.filter((_, i) => i !== index)
  node.parent?.insertAfter(node, clone)
  return clone
}

/**
 * Remove a rule once it holds no declarations — so clearing the last property
 * from a selector drops the now-empty selector from the custom code instead of
 * leaving `.foo {}` behind. Comments don't count as content. Returns true when
 * the rule was removed.
 */
export function removeRuleIfEmpty(rule: ParsedRule): boolean {
  let hasDeclaration = false
  let hasNested = false
  rule.node.each((node) => {
    if (node.type === 'decl') hasDeclaration = true
    else if (node.type === 'rule' || node.type === 'atrule') hasNested = true
  })
  // Keep the rule if it still holds declarations OR nested rules (a nested-CSS
  // parent whose own last property was just cleared but that still wraps children).
  if (hasDeclaration || hasNested) return false
  rule.node.remove()
  return true
}

/** Append a new declaration to a rule. Returns false on invalid input. */
export function addDeclaration(rule: ParsedRule, prop: string, value: string, important: boolean): boolean {
  const cleanProp = prop.trim()
  const cleanValue = value.trim()
  if (!cleanProp || !cleanValue) return false
  appendDecl(rule.node, cleanProp, cleanValue, important)
  return true
}

/**
 * Reorder a rule's declarations to match `orderedDeclIds`. Detaches the decl
 * nodes and re-appends them in the requested order (non-declaration nodes like
 * comments keep their relative position at the front).
 */
export function reorderDeclarations(rule: ParsedRule, orderedDeclIds: string[]) {
  const byId = new Map(rule.declarations.map((d) => [d.declId, d.node]))
  const nodes = orderedDeclIds.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => Boolean(n))
  nodes.forEach((node) => node.remove())
  nodes.forEach((node) => rule.node.append(node))
}

/** Replace a rule's entire body by re-parsing edited CSS text for that rule. */
export function replaceRuleCss(rule: ParsedRule, ruleCss: string): { ok: true } | { ok: false; error: string } {
  try {
    const parsed = postcss.parse(ruleCss)
    const nodes = parsed.nodes.filter((n): n is Rule => n.type === 'rule')
    if (!nodes.length) return { ok: false, error: 'No CSS rule found in the edited text.' }
    rule.node.replaceWith(...parsed.nodes)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

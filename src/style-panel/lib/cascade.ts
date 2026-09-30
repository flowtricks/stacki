// Cascade resolution → a rule-centric, editable model.
//
// We surface each matching rule as its own card (selector + its declaration
// list), because all the editing operations the panel offers — rename a
// property, change a value, add, remove, reorder — are scoped to a single rule.
// Cascade information is preserved as per-declaration status: among the matching
// BASE rules (no pseudo-class / pseudo-element / @media), each property has one
// winner (by !important, then specificity, then document order); losing
// declarations are flagged `overriddenBy` so you still see what actually applies.

import { canonicalCompound, compareSpecificity, matchSelectorList, type MatchTarget } from './selectors'
import { isViewStatePseudoClass } from './states'
import type { ParsedRule, SelectorInfo, Specificity } from './types'

export type RuleKind = 'base' | 'pseudo-class' | 'pseudo-element' | 'at-rule'

// The interaction states the panel views (mirrors resolved.ts). A selector is
// "base" (applies in the resting view) unless its SUBJECT carries one of these or
// a pseudo-element. Structural pseudos (`:first-child`, `:nth-child`, `:not`) and
// pseudos on an ANCESTOR (`.u-section:first-child .u-heading`) keep it base — the
// subject is still styled at rest — so they must NOT push it into the pseudo bucket.
function subjectHasState(text: string): boolean {
  return canonicalCompound(text).pseudoClasses.some((pseudo) => isViewStatePseudoClass(pseudo))
}

export type DeclStatus = {
  winning: boolean
  /** Selector of the declaration that overrides this one, when not winning. */
  overriddenBy: string | null
}

export type MatchedRule = {
  rule: ParsedRule
  /** The selectors (within the rule's list) that matched the element. */
  matchedSelectors: SelectorInfo[]
  kind: RuleKind
  conditional: boolean
  /** Display label: strongest matched selector, prefixed with any at-context. */
  label: string
  /** Per-declaration cascade status, keyed by declId. */
  declStatus: Record<string, DeclStatus>
}

/**
 * The properties an element takes from its parent when no rule sets them on the
 * element itself (CSS "inherited properties"). A `<p>` in a `.section` that sets
 * `color` is that colour until something targets the `<p>` — and anything that
 * does, however weak (`p`), beats what came down from the parent.
 *
 * Custom properties inherit too, but they are read through `var()`, where the
 * panel already shows where the value is defined, so they are left out here.
 */
export const INHERITED_PROPERTIES: ReadonlySet<string> = new Set([
  'accent-color', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color',
  'color', 'cursor', 'direction', 'empty-cells', 'fill', 'font', 'font-family',
  'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-size',
  'font-stretch', 'font-style', 'font-variant', 'font-variation-settings', 'font-weight',
  'hyphens', 'letter-spacing', 'line-height', 'list-style', 'list-style-image',
  'list-style-position', 'list-style-type', 'orphans', 'overflow-wrap', 'pointer-events',
  'quotes', 'stroke', 'tab-size', 'text-align', 'text-align-last', 'text-indent',
  'text-justify', 'text-shadow', 'text-transform', 'text-underline-offset',
  'text-underline-position', 'text-wrap', 'visibility', 'white-space', 'widows',
  'word-break', 'word-spacing', 'writing-mode',
])

/** The rules that reach one ancestor, `depth` generations above the element. */
export type InheritedLevel = {
  readonly depth: number
  readonly rules: readonly MatchedRule[]
}

export type RuleModel = {
  base: MatchedRule[]
  conditional: MatchedRule[]
  matchedRuleCount: number
  /**
   * What the element's ancestors are styled with, nearest first, restricted to
   * rules that set an inherited property. Absent when no ancestor is styled that
   * way (or none is known).
   */
  inherited?: readonly InheritedLevel[]
}

// Deeper than any real page; the walk stops at the root long before this. The
// cap only exists so a corrupted parent chain (a cycle) cannot loop forever.
const MAX_INHERITANCE_DEPTH = 64

type Hit = {
  rule: ParsedRule
  matchedSelectors: SelectorInfo[]
  strongestBase: { selector: SelectorInfo; specificity: Specificity } | null
  conditional: boolean
  kind: RuleKind
  label: string
}

/**
 * Cascade tie-break for one property, winner-first: `!important`, then
 * specificity, then document order (later wins). Shared by computeRuleModel and
 * the resolved-style model (lib/resolved.ts) so both agree on who wins.
 */
export function compareCascade(
  a: { important: boolean; specificity: Specificity },
  b: { important: boolean; specificity: Specificity },
  aOrder: number,
  bOrder: number,
): number {
  if (a.important !== b.important) {return a.important ? -1 : 1}
  const spec = compareSpecificity(b.specificity, a.specificity)
  if (spec !== 0) {return spec}
  return bOrder - aOrder // later wins on a tie
}

function strongestOf(selectors: SelectorInfo[]): { selector: SelectorInfo; specificity: Specificity } | null {
  let best: { selector: SelectorInfo; specificity: Specificity } | null = null
  for (const selector of selectors) {
    if (!best || compareSpecificity(selector.specificity, best.specificity) > 0) {
      best = { selector, specificity: selector.specificity }
    }
  }
  return best
}

export async function computeRuleModel(rules: ParsedRule[], target: MatchTarget): Promise<RuleModel> {
  const model = await computeRuleModelAt(rules, target)
  const inherited = await computeInheritedLevels(rules, target)
  return inherited.length ? { ...model, inherited } : model
}

// The same matching, run once per ancestor against only the rules that could hand
// something down. The element's own rules are matched first and separately, so
// this never delays the answer the panel needs to paint.
async function computeInheritedLevels(rules: ParsedRule[], target: MatchTarget): Promise<InheritedLevel[]> {
  const carriers = rules.filter((rule) => rule.declarations.some((decl) => INHERITED_PROPERTIES.has(decl.prop)))
  if (!carriers.length) {return []}
  const levels: InheritedLevel[] = []
  let key = target.view.parentKey(target.rootKey)
  for (let depth = 1; key != null && depth <= MAX_INHERITANCE_DEPTH; depth += 1) {
    const model = await computeRuleModelAt(carriers, { rootKey: key, view: target.view })
    if (model.matchedRuleCount > 0) {levels.push({ depth, rules: [...model.base, ...model.conditional] })}
    key = target.view.parentKey(key)
  }
  return levels
}

async function computeRuleModelAt(rules: ParsedRule[], target: MatchTarget): Promise<RuleModel> {
  const hits: Hit[] = []

  for (const rule of rules) {
    const results = await matchSelectorList(rule.selectorText, target)
    const matchedSelectors = rule.selectors.filter((_, index) => results[index]?.matched)
    if (!matchedSelectors.length) {continue}

    // Show every selector in the rule that actually targets this element — so a
    // grouped rule like `::before, ::after { … }` lists both halves.
    const selectorText = matchedSelectors.map((s) => s.text).join(', ')

    let conditional: boolean
    let kind: RuleKind
    let strongestBase: Hit['strongestBase'] = null
    let label: string

    if (rule.atContext.length > 0) {
      conditional = true
      kind = 'at-rule'
      label = `${rule.atContext.join(' › ')} ${selectorText}`
    } else {
      const baseSelectors = matchedSelectors.filter((s) => !subjectHasState(s.text) && s.pseudoElement == null)
      if (baseSelectors.length) {
        conditional = false
        kind = 'base'
        strongestBase = strongestOf(baseSelectors)
        label = selectorText
      } else {
        conditional = true
        kind = matchedSelectors.some((s) => s.pseudoElement != null) ? 'pseudo-element' : 'pseudo-class'
        label = selectorText
      }
    }

    hits.push({ rule, matchedSelectors, strongestBase, conditional, kind, label })
  }

  // Cascade winners among base hits, keyed by property.
  type Contribution = { declId: string; prop: string; important: boolean; specificity: Specificity; seq: number; selectorText: string }
  const contributions: Contribution[] = []
  let seq = 0
  for (const hit of hits) {
    if (hit.conditional || !hit.strongestBase) {continue}
    for (const decl of hit.rule.declarations) {
      contributions.push({
        declId: decl.declId,
        prop: decl.prop,
        important: decl.important,
        specificity: hit.strongestBase.specificity,
        seq: seq++,
        selectorText: hit.strongestBase.selector.text,
      })
    }
  }

  const winners = new Map<string, { declId: string; selectorText: string }>()
  const byProp = new Map<string, Contribution[]>()
  contributions.forEach((c) => {
    const list = byProp.get(c.prop) ?? []
    list.push(c)
    byProp.set(c.prop, list)
  })
  byProp.forEach((list, prop) => {
    const winner = [...list].sort((a, b) => compareCascade(a, b, a.seq, b.seq))[0]
    if (winner === undefined) {
      throw new Error(`Cascade invariant failed: ${prop} has no contributions`)
    }
    winners.set(prop, { declId: winner.declId, selectorText: winner.selectorText })
  })

  const base: MatchedRule[] = []
  const conditional: MatchedRule[] = []

  for (const hit of hits) {
    const declStatus: Record<string, DeclStatus> = {}
    for (const decl of hit.rule.declarations) {
      if (hit.conditional) {
        declStatus[decl.declId] = { winning: true, overriddenBy: null }
        continue
      }
      const winner = winners.get(decl.prop)
      declStatus[decl.declId] = winner && winner.declId === decl.declId
        ? { winning: true, overriddenBy: null }
        : { winning: false, overriddenBy: winner ? winner.selectorText : null }
    }

    const matched: MatchedRule = {
      rule: hit.rule,
      matchedSelectors: hit.matchedSelectors,
      kind: hit.kind,
      conditional: hit.conditional,
      label: hit.label,
      declStatus,
    }
    ;(hit.conditional ? conditional : base).push(matched)
  }

  base.sort((a, b) => a.rule.order - b.rule.order)
  conditional.sort((a, b) => a.rule.order - b.rule.order)

  return { base, conditional, matchedRuleCount: hits.length }
}

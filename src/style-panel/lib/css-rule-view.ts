// Read-only CSS assembled from the rules that match the selected element.
// Keeping formatting here makes the cascade view deterministic and testable without
// mounting CodeMirror or the complete style panel.

import type { MatchedRule } from './cascade'
import { compareSpecificity, selectorListMembers } from './selectors'
import type { Specificity } from './types'

export type CssRuleHighlight = {
  readonly from: number
  readonly to: number
  readonly className: string
}

export type CssRuleRange = {
  readonly from: number
  readonly to: number
}

export type CssRuleView = {
  readonly code: string
  readonly highlights: readonly CssRuleHighlight[]
  readonly selectorLists: readonly CssRuleRange[]
  readonly selectors: readonly CssRuleRange[]
}

type RankedRule = {
  readonly matched: MatchedRule
  readonly specificity: Specificity
}

type RuleCode = CssRuleView

const OVERRIDDEN_CLASS = 'embed-editor_css-code-overridden'

function strongestSpecificity(matched: MatchedRule): Specificity {
  let strongest: Specificity = [0, 0, 0]
  for (const selector of matched.matchedSelectors) {
    if (compareSpecificity(selector.specificity, strongest) > 0) {
      strongest = selector.specificity
    }
  }
  return strongest
}

function indent(depth: number): string {
  return '  '.repeat(depth)
}

function formatRule(matched: MatchedRule): RuleCode {
  const parts: string[] = []
  const highlights: CssRuleHighlight[] = []
  const selectorLists: CssRuleRange[] = []
  const selectors: CssRuleRange[] = []
  let length = 0
  const append = (text: string) => {parts.push(text); length += text.length}
  let depth = 0

  for (const context of matched.rule.atContext) {
    append(`${indent(depth)}${context} {\n`)
    depth += 1
  }
  const selectorIndent = indent(depth)
  const selectorFrom = length + selectorIndent.length
  append(`${selectorIndent}${matched.rule.selectorText} {\n`)
  selectorLists.push({ from: selectorFrom, to: selectorFrom + matched.rule.selectorText.length })
  const matchedTexts = new Set(matched.matchedSelectors.map((selector) => selector.text))
  for (const member of selectorListMembers(matched.rule.selectorText)) {
    if (!matchedTexts.has(member.text)) {continue}
    selectors.push({ from: selectorFrom + member.from, to: selectorFrom + member.to })
  }
  if (selectors.length === 0 && matched.matchedSelectors.length > 0) {
    selectors.push({ from: selectorFrom, to: selectorFrom + matched.rule.selectorText.length })
  }
  for (const declaration of matched.rule.declarations) {
    const line = `${indent(depth + 1)}${declaration.prop}: ${declaration.value}`
      + `${declaration.important ? ' !important' : ''};`
    const from = length
    append(`${line}\n`)
    if (matched.declStatus[declaration.declId]?.winning === false) {
      highlights.push({ from, to: from + line.length, className: OVERRIDDEN_CLASS })
    }
  }
  append(`${indent(depth)}}`)
  while (depth > 0) {
    depth -= 1
    append(`\n${indent(depth)}}`)
  }
  return { code: parts.join(''), highlights, selectorLists, selectors }
}

/** Format matching rules strongest-first, preserving source order as a tiebreaker. */
export function buildCssRuleView(rules: readonly MatchedRule[]): CssRuleView {
  const ranked: RankedRule[] = rules.map((matched) => ({
    matched,
    specificity: strongestSpecificity(matched),
  }))
  ranked.sort((first, second) =>
    compareSpecificity(second.specificity, first.specificity)
      || second.matched.rule.order - first.matched.rule.order,
  )

  const parts: string[] = []
  const highlights: CssRuleHighlight[] = []
  const selectorLists: CssRuleRange[] = []
  const selectors: CssRuleRange[] = []
  let offset = 0
  for (const entry of ranked) {
    const rule = formatRule(entry.matched)
    if (parts.length > 0) {parts.push('\n\n'); offset += 2}
    parts.push(rule.code)
    for (const highlight of rule.highlights) {
      highlights.push({
        from: highlight.from + offset,
        to: highlight.to + offset,
        className: highlight.className,
      })
    }
    for (const selector of rule.selectors) {
      selectors.push({ from: selector.from + offset, to: selector.to + offset })
    }
    for (const selectorList of rule.selectorLists) {
      selectorLists.push({ from: selectorList.from + offset, to: selectorList.to + offset })
    }
    offset += rule.code.length
  }
  return { code: parts.join(''), highlights, selectorLists, selectors }
}

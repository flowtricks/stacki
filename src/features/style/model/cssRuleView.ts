// Read-only CSS assembled from the rules that match the selected element.
// Keeping formatting here makes the cascade view deterministic and testable without
// mounting CodeMirror or the complete style panel.

import type { MatchedRule } from './cascade';
import { compareSpecificity, selectorListMembers } from './selectors';
import type { Specificity } from './styleTypes';
import { indentedRuleHead } from './cssRuleText';
import { CODE_INDENT_UNIT } from '../../../../shared/core/indent';

export type CssRuleHighlight = {
  readonly from: number;
  readonly to: number;
  readonly className: string;
};

export type CssRuleRange = {
  readonly from: number;
  readonly to: number;
};

export type CssRuleView = {
  readonly code: string;
  readonly highlights: readonly CssRuleHighlight[];
  readonly selectorLists: readonly CssRuleRange[];
  readonly selectors: readonly CssRuleRange[];
};

type RankedRule = {
  readonly matched: MatchedRule;
  readonly specificity: Specificity;
};

type RuleCode = CssRuleView;

const OVERRIDDEN_CLASS = 'embed-editor_css-code-overridden';

function strongestSpecificity(matched: MatchedRule): Specificity {
  let strongest: Specificity = [0, 0, 0];
  for (const selector of matched.matchedSelectors) {
    if (compareSpecificity(selector.specificity, strongest) > 0) {
      strongest = selector.specificity;
    }
  }
  return strongest;
}

function indent(depth: number): string {
  return CODE_INDENT_UNIT.repeat(depth);
}

function formatRule(matched: MatchedRule): RuleCode {
  const parts: string[] = [];
  const highlights: CssRuleHighlight[] = [];
  const selectorLists: CssRuleRange[] = [];
  const selectors: CssRuleRange[] = [];
  let length = 0;
  const append = (text: string) => {
    parts.push(text);
    length += text.length;
  };
  let depth = 0;
  // Shown as written. The resolved `selectorText` is what matching uses, and a
  // nested rule reads as a different rule when it is printed flat.
  const written = matched.rule.written;
  let selectorLine: CssRuleRange | undefined;
  for (const level of written?.parents ?? matched.rule.atContext) {
    const line = indentedRuleHead(level, depth);
    if (!level.startsWith('@')) {
      selectorLine = { from: length + indent(depth).length, to: length + line.length };
    }
    append(`${line} {\n`);
    depth += 1;
  }
  const head = written === undefined ? matched.rule.selectorText : indentedRuleHead(written.head, depth).slice(depth);
  const headFrom = length + depth;
  append(`${indent(depth)}${head} {\n`);
  // A nested query's own declarations have no selector line of their own: they
  // belong to the selector around the query, and that line is the one to mark.
  const selectorRange = head.startsWith('@') ? selectorLine : { from: headFrom, to: headFrom + head.length };
  if (selectorRange !== undefined) {
    selectorLists.push(selectorRange);
    const matchedTexts = new Set(matched.matchedSelectors.map((selector) => selector.text));
    for (const member of selectorListMembers(head)) {
      if (matchedTexts.has(member.text)) {
        selectors.push({ from: headFrom + member.from, to: headFrom + member.to });
      }
    }
    // A nested member is written unresolved, so it is not the text that matched.
    if (selectors.length === 0 && matched.matchedSelectors.length > 0) {
      selectors.push(selectorRange);
    }
  }
  for (const declaration of matched.rule.declarations) {
    const line = `${indent(depth + 1)}${declaration.prop}: ${declaration.value}` + `${declaration.important ? ' !important' : ''};`;
    const from = length;
    append(`${line}\n`);
    if (matched.declStatus[declaration.declId]?.winning === false) {
      highlights.push({ from, to: from + line.length, className: OVERRIDDEN_CLASS });
    }
  }
  append(`${indent(depth)}}`);
  while (depth > 0) {
    depth -= 1;
    append(`\n${indent(depth)}}`);
  }
  return { code: parts.join(''), highlights, selectorLists, selectors };
}

/** Format matching rules strongest-first, preserving source order as a tiebreaker. */
export function buildCssRuleView(rules: readonly MatchedRule[]): CssRuleView {
  const ranked: RankedRule[] = rules.map((matched) => ({
    matched,
    specificity: strongestSpecificity(matched),
  }));
  ranked.sort((first, second) => compareSpecificity(second.specificity, first.specificity) || second.matched.rule.order - first.matched.rule.order);

  const parts: string[] = [];
  const highlights: CssRuleHighlight[] = [];
  const selectorLists: CssRuleRange[] = [];
  const selectors: CssRuleRange[] = [];
  let offset = 0;
  for (const entry of ranked) {
    const rule = formatRule(entry.matched);
    if (parts.length > 0) {
      parts.push('\n\n');
      offset += 2;
    }
    parts.push(rule.code);
    for (const highlight of rule.highlights) {
      highlights.push({
        from: highlight.from + offset,
        to: highlight.to + offset,
        className: highlight.className,
      });
    }
    for (const selector of rule.selectors) {
      selectors.push({ from: selector.from + offset, to: selector.to + offset });
    }
    for (const selectorList of rule.selectorLists) {
      selectorLists.push({ from: selectorList.from + offset, to: selectorList.to + offset });
    }
    offset += rule.code.length;
  }
  return { code: parts.join(''), highlights, selectorLists, selectors };
}

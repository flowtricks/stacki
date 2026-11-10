// Style panel edits shown on the canvas at once. An edit used to appear only after the source
// was saved and the page re-rendered on the server, about half a second later. The panel now
// also sends the edited rule here, and the canvas sets the property on the same rule in its
// loaded stylesheets. The real update follows with the same content and replaces these
// sheets, which corrects anything this could not match (it then does nothing: a new rule, a
// nested one, or a selector it does not recognise).

import { record, string } from '../../shared/validation';

export interface LiveRule {
  readonly selector: string;
  /** Enclosing at-rules, outermost first, as the source writes them (`@media (max-width: 767px)`). */
  readonly atContext: readonly string[];
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}

const RULES_VISITED_MAX = 20_000;
const AT_CONTEXT_MAX = 8;
const PROPERTY = /^(--[\w-]+|-?[a-z][a-z0-9-]*)$/;

/** Parse a `studio:live-rule` message from Studio; anything else is undefined. */
export function parseLiveRule(input: unknown): LiveRule | undefined {
  try {
    const data = record(input);
    if (data['type'] !== 'studio:live-rule') {
      return undefined;
    }
    const atContext = data['atContext'];
    if (!Array.isArray(atContext) || atContext.length > AT_CONTEXT_MAX) {
      return undefined;
    }
    const rule: LiveRule = {
      selector: string(data['selector'], 2000),
      atContext: atContext.map((entry) => string(entry, 500)),
      prop: string(data['prop'], 120),
      value: string(data['value'], 2000),
      important: data['important'] === true,
    };
    return PROPERTY.test(rule.prop) && rule.selector.length > 0 ? rule : undefined;
  } catch {
    return undefined;
  }
}

/** A selector without Astro's scoping and with uniform spacing, for comparing source and CSSOM. */
export function normalizeSelector(selector: string): string {
  return selector
    .replace(/\[data-astro-cid-[\w-]+\]/g, '')
    .replace(/:where\(\.astro-[\w-]+\)/g, '')
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An at-rule prelude with all spacing removed, so `(max-width:767px)` and `( max-width: 767px )` match. */
export function normalizeAtRule(prelude: string): string {
  return prelude.replace(/\s+/g, '').toLowerCase();
}

// The rule classes of the document's own window: the canvas frame's, and in tests a jsdom
// window's. A window that lacks a class (an older browser, jsdom) has no such rules either.
interface RuleClasses {
  readonly style: typeof CSSStyleRule;
  readonly media: typeof CSSMediaRule | undefined;
  readonly supports: typeof CSSSupportsRule | undefined;
  readonly container: typeof CSSContainerRule | undefined;
  readonly layer: typeof CSSLayerBlockRule | undefined;
}

function ruleClassesOf(view: Window & typeof globalThis): RuleClasses {
  return {
    style: view.CSSStyleRule,
    media: view.CSSMediaRule,
    supports: view.CSSSupportsRule,
    container: view.CSSContainerRule,
    layer: view.CSSLayerBlockRule,
  };
}

function atRuleOf(rule: CSSRule, classes: RuleClasses): string | undefined {
  if (classes.media && rule instanceof classes.media) {
    return `@media ${rule.media.mediaText}`;
  }
  if (classes.supports && rule instanceof classes.supports) {
    return `@supports ${rule.conditionText}`;
  }
  if (classes.container && rule instanceof classes.container) {
    return `@container ${rule.containerName} ${rule.containerQuery}`.replace(/\s+/, ' ');
  }
  if (classes.layer && rule instanceof classes.layer) {
    return `@layer ${rule.name}`;
  }
  return undefined;
}

function isCondition(prelude: string): boolean {
  return !prelude.startsWith('@layer');
}

/** Set the edited property on every matching rule in the document's stylesheets; returns how many. */
export function applyLiveRule(document: Document, live: LiveRule): number {
  const view = document.defaultView;
  if (view === null) {
    return 0;
  }
  const classes = ruleClassesOf(view);
  const selector = normalizeSelector(live.selector);
  // Layers order the cascade but don't change which elements a rule matches, and the panel's
  // context may leave them out, so only the conditions (@media, @supports, @container) compare.
  const context = live.atContext.map(normalizeAtRule).filter(isCondition);
  let visited = 0;
  let applied = 0;
  // Iterative: each entry is a rule list and the at-rule chain around it.
  const pending: { readonly rules: CSSRuleList; readonly chain: readonly string[] }[] = [];
  for (const sheet of document.styleSheets) {
    try {
      pending.push({ rules: sheet.cssRules, chain: [] });
    } catch {
      // A cross-origin sheet cannot be read, and holds none of the site's own rules.
    }
  }
  while (pending.length > 0 && visited < RULES_VISITED_MAX) {
    const entry = pending.pop();
    if (!entry) {
      break;
    }
    for (const rule of entry.rules) {
      visited += 1;
      if (rule instanceof classes.style) {
        const chain = entry.chain.filter(isCondition);
        const sameContext = chain.length === context.length && chain.every((prelude, index) => prelude === context[index]);
        if (sameContext && normalizeSelector(rule.selectorText) === selector) {
          rule.style.setProperty(live.prop, live.value, live.important ? 'important' : '');
          applied += 1;
        }
        continue;
      }
      const prelude = atRuleOf(rule, classes);
      if (prelude !== undefined && 'cssRules' in rule && rule.cssRules instanceof view.CSSRuleList && entry.chain.length < AT_CONTEXT_MAX) {
        pending.push({ rules: rule.cssRules, chain: [...entry.chain, normalizeAtRule(prelude)] });
      }
    }
  }
  return applied;
}

/** Apply a live rule message, if this is one. */
export function receiveLiveRule(input: unknown): boolean {
  const live = parseLiveRule(input);
  if (live === undefined) {
    return false;
  }
  applyLiveRule(document, live);
  return true;
}

// The frame's size, as the canvas needs it: the page's own content height,
// reported to the app, and vh units frozen to the breakpoint's viewport, so a
// frame stretched to the whole page does not stretch what is measured in it.

import { PRELOAD_LIMITS } from './frameBasics';
import { freezeViewportValue, parseViewportHeight } from './frameViewportUnits';
import { freezeInlineViewport } from './frameViewportInline';

// documentElement.scrollHeight is clamped to the viewport (= the iframe),
// so once the frame is stretched it can never report a smaller page — a
// one-way ratchet. Measure the body's own content height instead; the
// frozen-mode override un-stretches html/body so this reflects content.
export const report = () => {
  try {
    const body = document.body;
    let height;
    if (body) {
      const styles = getComputedStyle(body);
      height = body.offsetTop + body.scrollHeight + (parseFloat(styles.marginBottom) || 0);
    } else {
      height = document.documentElement.scrollHeight;
    }
    window.parent.postMessage({ type: 'avb:page-height', height: Math.ceil(height) }, '*');
  } catch {
    /* ignore */
  }
};

// Canvas frames stretch to the full page height, which would make vh units
// (viewport = iframe) track the frame instead of a screen — a 100vh hero
// would fill the whole frame and the measured height would chase its own
// tail (every breakpoint converging to the same height). The app posts
// `avb:set-vh` with the breakpoint's real viewport height; we freeze vh by
// copying every rule that uses vh units into an override stylesheet with
// `Xvh` → `calc(X * var(--avb-vh))`, where --avb-vh is 1% of that height.
let overrideElement: HTMLStyleElement | undefined = undefined;
let rewriteTimer: ReturnType<typeof setTimeout> | undefined;

// Copies ONLY the declarations that need freezing (vh units, position:
// fixed) into the override — never whole rule bodies. Re-asserting entire
// rules at the end of the cascade would let base rules beat utility
// classes that legitimately override them later in source order.
const filterRule = (rule: CSSRule, depth: number): string => {
  if (depth > PRELOAD_LIMITS.cssRuleDepthMax) {
    return '';
  }
  if (asImport(rule)) {
    return filterImportRule(rule, depth);
  }
  if (asStyleLike(rule)) {
    return filterStyleRule(rule, depth);
  }
  // Grouping rule (@media, @supports, @layer, @keyframes …) — recurse.
  if (rule instanceof CSSGroupingRule && rule.cssRules.length) {
    const inner = filterRules(rule.cssRules, depth + 1);
    if (!inner) {
      return '';
    }
    const head = rule.cssText.slice(0, rule.cssText.indexOf('{'));
    return head + '{\n' + inner + '}\n';
  }
  return '';
};

// Every rule of a list, filtered and joined in order. CSSRuleList isn't
// iterable in the type library, so an index loop walks it.
const filterRules = (rules: CSSRuleList, depth: number): string => {
  let out = '';
  for (let ri = 0; ri < rules.length; ri++) {
    const child = rules[ri];
    if (child) {
      out += filterRule(child, depth);
    }
  }
  return out;
};

// An @import brings a whole stylesheet in, and its rules hang off
// `rule.styleSheet`, not `rule.cssRules` — so a sheet reached this way was
// invisible here. That's where a design system's `body { min-height:
// 100svh }` usually lives, and leaving it live is what makes a stretched
// canvas frame grow without end: svh tracks the frame, body grows, the
// page reports a taller height, the frame stretches again.
const filterImportRule = (rule: CSSImportRule, depth: number): string => {
  // Still loading: nothing to copy yet, and no <head> mutation will
  // announce it later, so ask for another pass.
  if (!rule.styleSheet) {
    importsPending = true;
    return '';
  }
  let inner = '';
  try {
    inner = filterRules(rule.styleSheet.cssRules, depth + 1);
  } catch {
    return ''; // cross-origin import — can't read it
  }
  if (!inner) {
    return '';
  }
  // Keep whatever layer it was imported into, or the copy would outrank
  // (or be outranked by) the original.
  const layer = /\blayer\(([^)]*)\)/i.exec(rule.cssText || '');
  if (!layer) {
    return inner;
  }
  const layerBody = layer[1] ?? '';
  return `@layer ${layerBody.trim()} {\n${inner}}\n`;
};

// With CSS nesting a style rule is BOTH: it has its own declarations and
// it contains rules. Taking the grouping branch on the strength of
// `cssRules` alone skipped everything the rule itself declared — which is
// exactly where `body { min-height: 100svh; > main { … } }` hides, and why
// a frame with that in its stylesheet grew without end.
const filterStyleRule = (rule: CSSStyleRule | CSSKeyframeRule, depth: number): string => {
  let nested = '';
  if (rule instanceof CSSGroupingRule && rule.cssRules.length) {
    nested = filterRules(rule.cssRules, depth + 1);
  }
  let decls = '';
  for (let di = 0; di < rule.style.length; di++) {
    const prop = rule.style.item(di);
    const value = rule.style.getPropertyValue(prop);
    const prio = rule.style.getPropertyPriority(prop);
    const frozenValue = freezeViewportValue(value);
    const hasVh = frozenValue !== value;
    const isFixed = prop === 'position' && /fixed/.test(value);
    if (!hasVh && !isFixed) {
      continue;
    }
    // position:fixed anchors to the stretched frame, so it becomes
    // absolute — headers/overlays sit at their page position instead of
    // floating mid-frame.
    const newValue = isFixed ? 'absolute' : frozenValue;
    decls += `${prop}: ${newValue}${prio ? ' !important' : ''}; `;
  }
  // Nested matches are re-emitted inside their parent, keeping the nesting
  // (and so the `&` context) they were written with.
  if (!decls && !nested) {
    return '';
  }
  const selector = selectorOf(rule);
  return `${selector} { ${decls}${nested ? '\n' + nested : ''}}\n`;
};

// The original checks these the same way (type constants and property
// truthiness); the predicates just make the branches type-narrow.
const asImport = (rule: CSSRule): rule is CSSImportRule =>
  rule.type === 3 || ('styleSheet' in rule && !!rule['styleSheet']);
const asStyleLike = (rule: CSSRule): rule is CSSStyleRule | CSSKeyframeRule => {
  if (!('style' in rule) || !rule['style']) {
    return false;
  }
  const selectorText = 'selectorText' in rule ? rule['selectorText'] : undefined;
  const keyText = 'keyText' in rule ? rule['keyText'] : undefined;
  return !!(selectorText || keyText);
};
const selectorOf = (rule: CSSStyleRule | CSSKeyframeRule): string => {
  const selectorText = 'selectorText' in rule ? rule.selectorText : undefined;
  const keyText = 'keyText' in rule ? rule.keyText : undefined;
  return selectorText || keyText || '';
};

let importsPending = false;
let importRetries = 0;
const rewriteSheets = () => {
  if (!document.head) {
    return;
  }
  importsPending = false;
  // Un-stretch html/body so the frame's height comes from content, not
  // from the (stretched) viewport — kills height:100% feedback.
  let css = 'html, body { height: auto !important; }\n';
  const sheets = document.styleSheets;
  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    if (!sheet) {
      continue;
    }
    if (sheet.ownerNode === overrideElement) {
      continue;
    }
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet — can't read, leave it be
    }
    css += filterRules(rules, 0);
  }
  if (!overrideElement) {
    overrideElement = document.createElement('style');
    overrideElement.id = 'avb-vh-override';
  }
  if (overrideElement.textContent !== css) {
    overrideElement.textContent = css;
  }
  if (document.head.lastElementChild !== overrideElement) {
    document.head.appendChild(overrideElement);
  }
  // An @import that hadn't finished loading has rules we still need, and it
  // won't touch <head> when it arrives — so nothing else would bring us
  // back. Try again shortly, a bounded number of times.
  if (importsPending && importRetries < 25) {
    importRetries += 1;
    setTimeout(rewriteSheets, 120);
  }
};

const scheduleRewrite = () => {
  clearTimeout(rewriteTimer);
  rewriteTimer = setTimeout(() => {
    rewriteSheets();
    report();
  }, 100);
};

let frozen = false;

export const freezeViewportHeight = (value: unknown) => {
  const px = parseViewportHeight(value);
  if (px === undefined) {
    return;
  }
  document.documentElement.style.setProperty('--avb-vh', px / 100 + 'px');
  if (!frozen) {
    frozen = true;
    rewriteSheets();
    freezeInlineViewport(report);
    // Subresources — @import among them — are done by `load`, so take one
    // more pass then even if the retries above have run out.
    window.addEventListener('load', scheduleRewrite);
    // Vite HMR injects/replaces <style> tags — keep the override current
    // (and last in the cascade).
    new MutationObserver(scheduleRewrite).observe(document.head || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  report();
};

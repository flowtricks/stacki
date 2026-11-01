// The <style> regions of a file and the declaration primitives every rule edit
// is made of: finding a child rule, setting, appending and terminating
// declarations (css.ts).

import postcss, { type Root, type Rule, type AtRule, type Declaration } from 'postcss';
import type { StyleRegion } from './styleTypes';
import { selectorKey } from './resolved';
import { isPaddingProperty, setPaddingDeclaration } from './spacingShorthand';

/** A declaration's value and whether it is `!important` — the two always travel together. */
export type DeclarationValue = { readonly value: string; readonly important: boolean };

// Selectors and query params compare with whitespace removed and case folded.
export const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();

// The first direct child rule of `container` that `matches` accepts.
export function childRule(container: Root | Rule | AtRule, matches: (rule: Rule) => boolean): Rule | undefined {
  return container.nodes?.find((child): child is Rule => child.type === 'rule' && matches(child));
}

// The first direct child at-rule named `name` (lowercase) whose params equal `params`.
export function childAtRule(container: Root | Rule | AtRule, name: string, params: string): AtRule | undefined {
  return container.nodes?.find(
    (child): child is AtRule => child.type === 'atrule' && child.name.toLowerCase() === name && squash(child.params) === squash(params),
  );
}

// Terminate the last declaration with `;` (postcss omits it unless this is set). The
// node is edited in place through postcss's own `assign`, as every edit here is.
export function terminateDeclarations(node: Rule | AtRule): void {
  node.assign({ raws: { ...node.raws, semicolon: true } });
}

// A direct child rule of `container` whose selector is the SAME target as `selector`
// (by selectorKey, so `.a.b` === `.b.a`) — used to merge into an existing rule rather
// than appending a duplicate. Only direct children (not nested) so a flat add stays flat.
export function findChildRuleBySelector(container: Root | AtRule, selector: string): Rule | undefined {
  const key = selectorKey(selector);
  return childRule(container, (rule) => selectorKey(rule.selector) === key);
}

// Update the rule's existing declaration for `prop`, or append it — mirrors onSetProp.
export function setDeclOnRule(rule: Rule, prop: string, declared: DeclarationValue) {
  if (isPaddingProperty(prop)) {
    setPaddingDeclaration(rule, prop, declared);
    return;
  }
  const found: Declaration[] = [];
  rule.walkDecls(prop, (declaration) => {
    found.push(declaration);
  });
  const last = found.at(-1);
  if (last) {
    last.value = declared.value;
    last.important = declared.important;
  } else {
    rule.append({ prop, value: declared.value, important: declared.important });
  }
  terminateDeclarations(rule);
}

export const STYLE_OPEN = /<style\b[^>]*>/gi;
export const STYLE_CLOSE = '</style>';

/** Locate every `<style>...</style>` region and capture its inner CSS + offsets. */
export function extractStyleRegions(code: string): StyleRegion[] {
  const regions: StyleRegion[] = [];
  const lower = code.toLowerCase();
  STYLE_OPEN.lastIndex = 0;
  // A global regex advances `lastIndex` on every match, so each tag is visited once.
  for (let match = STYLE_OPEN.exec(code); match !== null; match = STYLE_OPEN.exec(code)) {
    const innerStart = match.index + match[0].length;
    const closeIndex = lower.indexOf(STYLE_CLOSE, innerStart);
    if (closeIndex === -1) {
      break;
    }
    regions.push({
      start: innerStart,
      end: closeIndex,
      css: code.slice(innerStart, closeIndex),
      root: undefined,
      openTag: match[0],
    });
    STYLE_OPEN.lastIndex = closeIndex + STYLE_CLOSE.length;
  }
  return regions;
}

/** Parse a region's CSS into a postcss Root, recording any parse error. Returns the
 *  parsed region; the one passed in is left as it was. */
export function parseRegion(region: StyleRegion): StyleRegion {
  try {
    return { ...region, root: postcss.parse(region.css), parseError: undefined };
  } catch (error: unknown) {
    const parseError = error instanceof Error ? error.message : String(error);
    return { ...region, root: undefined, parseError };
  }
}

/**
 * Split an embed into immutable HTML segments interleaved with style regions.
 * `segments` has `regions.length + 1` entries: the literal code before each
 * region's inner CSS (including the `<style…>`/`</style>` tags) and the trailing
 * code. Rebuilding from segments avoids any offset bookkeeping across edits.
 */
export function splitEmbed(code: string): { segments: string[]; regions: StyleRegion[] } {
  const regions = extractStyleRegions(code);
  const segments: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    segments.push(code.slice(cursor, region.start));
    cursor = region.end;
  }
  segments.push(code.slice(cursor));
  return { segments, regions };
}

/** Reconstruct embed code by interleaving static segments with region roots. */
export function renderEmbed(segments: string[], regions: StyleRegion[]): string {
  let out = segments[0] ?? '';
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    if (region === undefined) {
      throw new Error(`Style region ${i} is missing`);
    }
    out += region.root ? region.root.toString() : region.css;
    out += segments[i + 1] ?? '';
  }
  return out;
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
  const out: Declaration[] = [];
  node.each((child) => {
    if (child.type === 'decl') {
      out.push(child as Declaration);
    }
  });
  return out;
}

/** Append a declaration, placing it before any nested rules so a parent's own decls stay
 *  grouped above its nested rules (e.g. bare decls at the top of a query block). */
export function appendDecl(node: Rule | AtRule, prop: string, declared: DeclarationValue): Declaration {
  const decl = postcss.decl({ prop, value: declared.value, important: declared.important });
  const firstNested = node.nodes?.find((child) => child.type === 'rule' || child.type === 'atrule');
  if (firstNested) {
    node.insertBefore(firstNested, decl);
  } else {
    node.append(decl);
  }
  terminateDeclarations(node);
  return decl;
}

/** Set (update-or-append) a DIRECT declaration on a node — scoped so a nested rule's
 *  declaration of the same prop is never mistaken for this node's own. */
export function setDeclDirect(node: Rule | AtRule, prop: string, declared: DeclarationValue) {
  if (isPaddingProperty(prop)) {
    setPaddingDeclaration(node, prop, declared);
    return;
  }
  const key = prop.trim().toLowerCase();
  const existing = directDecls(node).find((declaration) => declaration.prop.trim().toLowerCase() === key);
  if (existing) {
    existing.value = declared.value;
    existing.important = declared.important;
    terminateDeclarations(node);
  } else {
    appendDecl(node, prop, declared);
  }
}

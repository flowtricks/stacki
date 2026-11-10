// Live rule previews: what the app tells a canvas frame when the Style panel
// edits one declaration of a rule, before the file holds it.
//
// A Style panel edit used to reach the canvas only after the save, the dev
// server's re-render and the morph: about half a second. The app now also sends
// the edited declaration here, and the frame (electron/preload/frameLiveRules.ts,
// shared by Desktop's preload and Studio's preview client) sets it on the same
// rule in the stylesheet that the rule's own source file compiles to. This is
// the rule-level twin of liveVariables.ts and follows its lifecycle: `set`
// shows a value, `drop` without `until` puts the page's own value back at once
// (a refused or failed save, an abandoned edit), and `drop` with `until` keeps
// the preview only until the page's own stylesheet holds the written value, or
// `settleFramesMax` frames have passed, whichever comes first.
//
// Matching keeps Astro's scoping. Only stylesheets that belong to `source` are
// searched, and inside one, only that sheet's own scope attribute is set aside
// when comparing selectors (selectorKeyOf below): another component's scoped
// `.title` lives in another stylesheet with another scope, and is never touched.

import { assert } from '../core/assert';

export const LIVE_RULE_MESSAGE = 'avb:live-rule';

export const LIVE_RULE_LIMITS = {
  /** Previews held at once: one per property being edited, with headroom. */
  entriesMax: 64,
  /** Rules one preview may patch: the same selector repeated in one file's blocks. */
  patchesMax: 32,
  /** Rules indexed in one stylesheet. A sheet over this is not previewed, and says so. */
  sheetRulesMax: 20_000,
  sourceCharsMax: 1_000,
  selectorCharsMax: 2_000,
  /** At-rules around the rule. */
  contextMax: 8,
  contextCharsMax: 500,
  propertyCharsMax: 200,
  valueCharsMax: 2_000,
  /** How long a released preview waits for the page to agree before the page's own value is put back. */
  settleFramesMax: 180,
} as const satisfies Record<string, number>;

/** Which declaration: the rule's source file, its at-rules, its selector and the property. */
export interface LiveRuleTarget {
  /** The file the rule is written in, project-relative with `/` separators (`src/components/Card.astro`). */
  readonly source: string;
  /** Enclosing at-rules, outermost first, as the source writes them (`@media (max-width: 767px)`). */
  readonly context: readonly string[];
  /** The rule's selector as the source writes it, without Astro's scope (`.title`). */
  readonly selector: string;
  readonly property: string;
}

/** What the declaration now is. */
export type LiveRuleEdit = { readonly kind: 'value'; readonly value: string; readonly important: boolean } | { readonly kind: 'removed' };

export type LiveRuleMessage =
  | { readonly type: typeof LIVE_RULE_MESSAGE; readonly op: 'set'; readonly rule: LiveRuleTarget; readonly edit: LiveRuleEdit }
  /** `until`: the save landed with this edit; keep the preview until the page's own
   *  stylesheet holds it. Absent: the edit did not land, put the page's value back now. */
  | { readonly type: typeof LIVE_RULE_MESSAGE; readonly op: 'drop'; readonly rule: LiveRuleTarget; readonly until?: LiveRuleEdit | undefined };

/** The key two messages about one declaration share; spelling differences in the selector do not split it. */
export function liveRuleKey(rule: LiveRuleTarget): string {
  const context = rule.context.filter(isConditionAtRule).map(normalizeAtRule);
  const key = [rule.source, ...context, normalizeSelector(rule.selector), rule.property].join('\n');
  assert(key.length > 0, 'liveRuleKey: a key is never empty');
  assert(context.length <= rule.context.length, 'liveRuleKey: context is only ever filtered');
  return key;
}

// Text that ends a declaration or a block. CSSOM writes never splice text, but a
// value carrying its own `!important` or `;` would disagree with what the file holds.
const VALUE_BREAKOUT = /[{};!]/;
const SELECTOR_BREAKOUT = /[{};]/;
const PROPERTY = /^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/;
const AT_RULE = /^@[a-z-]+(?:\s|\(|$)/i;

function fragment(input: unknown, charsMax: number, breakout: RegExp): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > charsMax) {
    return undefined;
  }
  if (breakout.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

// A project-relative path: no parent segments, no query, no drive or root.
function sourceOf(input: unknown): string | undefined {
  const source = fragment(input, LIVE_RULE_LIMITS.sourceCharsMax, /[\0?#\\]/);
  if (source === undefined) {
    return undefined;
  }
  if (source.startsWith('/')) {
    return undefined;
  }
  if (source.split('/').some((segment) => segment === '..' || segment === '')) {
    return undefined;
  }
  assert(source.length <= LIVE_RULE_LIMITS.sourceCharsMax, 'sourceOf: bounded');
  return source;
}

function contextOf(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const values: readonly unknown[] = input;
  if (values.length > LIVE_RULE_LIMITS.contextMax) {
    return undefined;
  }
  const context: string[] = [];
  for (const value of values) {
    const part = fragment(value, LIVE_RULE_LIMITS.contextCharsMax, SELECTOR_BREAKOUT);
    if (part === undefined) {
      return undefined;
    }
    if (!AT_RULE.test(part)) {
      return undefined; // Parent selectors are resolved into `selector`; only at-rules belong here.
    }
    context.push(part);
  }
  assert(context.length === values.length, 'contextOf: every entry parsed');
  return context;
}

export function parseLiveRuleTarget(input: unknown): LiveRuleTarget | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const source = 'source' in input ? sourceOf(input.source) : undefined;
  const context = 'context' in input ? contextOf(input.context) : undefined;
  const selector = 'selector' in input ? fragment(input.selector, LIVE_RULE_LIMITS.selectorCharsMax, SELECTOR_BREAKOUT) : undefined;
  const property = 'property' in input ? fragment(input.property, LIVE_RULE_LIMITS.propertyCharsMax, VALUE_BREAKOUT) : undefined;
  if (source === undefined || context === undefined || selector === undefined || property === undefined) {
    return undefined;
  }
  if (!PROPERTY.test(property)) {
    return undefined;
  }
  return { source, context, selector, property };
}

/** An edit; a non-boolean `important` is refused, never coerced. */
export function parseLiveRuleEdit(input: unknown): LiveRuleEdit | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('kind' in input)) {
    return undefined;
  }
  if (input.kind === 'removed') {
    return { kind: 'removed' };
  }
  if (input.kind !== 'value') {
    return undefined;
  }
  const value = 'value' in input ? fragment(input.value, LIVE_RULE_LIMITS.valueCharsMax, VALUE_BREAKOUT) : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (!('important' in input) || typeof input.important !== 'boolean') {
    return undefined;
  }
  return { kind: 'value', value, important: input.important };
}

/** A message for the frame, or undefined when `input` is not one (or is malformed). */
export function parseLiveRuleMessage(input: unknown): LiveRuleMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== LIVE_RULE_MESSAGE || !('op' in input)) {
    return undefined;
  }
  const rule = 'rule' in input ? parseLiveRuleTarget(input.rule) : undefined;
  if (rule === undefined) {
    return undefined;
  }
  if (input.op === 'set') {
    const edit = 'edit' in input ? parseLiveRuleEdit(input.edit) : undefined;
    return edit === undefined ? undefined : { type: LIVE_RULE_MESSAGE, op: 'set', rule, edit };
  }
  if (input.op !== 'drop') {
    return undefined;
  }
  if (!('until' in input) || input.until === undefined) {
    return { type: LIVE_RULE_MESSAGE, op: 'drop', rule };
  }
  const until = parseLiveRuleEdit(input.until);
  return until === undefined ? undefined : { type: LIVE_RULE_MESSAGE, op: 'drop', rule, until };
}

// ───────────────────────────── Matching ─────────────────────────────

/** Layers order the cascade but do not change what a rule matches, and the panel's
 *  context may leave them out, so only the conditions (@media, @supports, @container) compare. */
export function isConditionAtRule(prelude: string): boolean {
  return !/^@layer\b/i.test(prelude.trim());
}

/** An at-rule prelude with all spacing removed and case folded, so `(max-width:767px)` and `( max-width: 767px )` match. */
export function normalizeAtRule(prelude: string): string {
  const normalized = prelude.replace(/\s+/g, '').toLowerCase();
  assert(normalized.length <= prelude.length, 'normalizeAtRule: only removes');
  assert(!/\s/.test(normalized), 'normalizeAtRule: no spacing left');
  return normalized;
}

/** A selector with uniform spacing around combinators and commas, `::` for the legacy pseudo-elements and
 *  quoted attribute values, as the browser serializes it. Scoping attributes are kept. */
export function normalizeSelector(selector: string): string {
  const normalized = selector
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/(^|[^:]):(before|after|first-line|first-letter)\b/g, '$1::$2')
    .replace(/\[\s*([\w-]+)\s*([~|^$*]?=)\s*([^"'\]\s]+)\s*\]/g, '[$1$2"$3"]')
    .trim();
  assert(!normalized.startsWith(' '), 'normalizeSelector: trimmed at the start');
  assert(!normalized.endsWith(' '), 'normalizeSelector: trimmed at the end');
  return normalized;
}

/** Whether the rule is scoped to its file or written wholly `:global(…)`. */
export type SelectorScope = 'scoped' | 'global';

/** The source's selector as the index keys it: `:global(…)` unwrapped, and which bucket it belongs in. */
export function sourceSelectorKey(selector: string): { readonly scope: SelectorScope; readonly selector: string } {
  const trimmed = selector.trim();
  const whole = /^:global\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/.exec(trimmed);
  const unwrapped = trimmed.replace(/:global\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '$1');
  const key = { scope: whole === null ? ('scoped' as const) : ('global' as const), selector: normalizeSelector(unwrapped) };
  assert(!key.selector.includes(':global('), 'sourceSelectorKey: :global is unwrapped');
  assert(key.selector.length <= trimmed.length + 64, 'sourceSelectorKey: normalizing adds little');
  return key;
}

// Astro's scope on a compiled selector: `[data-astro-cid-…]` (the default strategy) or
// `:where(.astro-…)`. Each file has its own; a sheet compiled from a scoped block carries
// exactly one.
const SCOPE = /\[data-astro-cid-([a-z0-9]+)\]|:where\(\.astro-([a-z0-9]+)\)/gi;

/** The one Astro scope every scoped selector of a sheet carries, or undefined when there is none or more than one. */
export function sheetScopeOf(selectors: readonly string[]): string | undefined {
  const scopes = new Set<string>();
  for (const selector of selectors) {
    for (const match of selector.matchAll(SCOPE)) {
      scopes.add((match[1] ?? match[2] ?? '').toLowerCase());
    }
    if (scopes.size > 1) {
      return undefined; // Two files' scopes in one sheet: nothing is this sheet's own.
    }
  }
  const [scope] = scopes;
  assert(scopes.size <= 1, 'sheetScopeOf: at most one scope');
  assert(scope === undefined || scope.length > 0, 'sheetScopeOf: a scope is never empty');
  return scope;
}

/** A compiled selector as the index keys it. Only `ownScope`, the sheet's own scope, is set aside: the
 *  source never writes it, and every scoped rule of the file carries it. Any other scope stays in the key. */
export function selectorKeyOf(selectorText: string, ownScope: string | undefined): { readonly scope: SelectorScope; readonly selector: string } {
  if (ownScope === undefined) {
    return { scope: 'global', selector: normalizeSelector(selectorText) };
  }
  let found = false;
  const stripped = selectorText.replace(SCOPE, (whole: string, attribute: string | undefined, where: string | undefined) => {
    const scope = (attribute ?? where ?? '').toLowerCase();
    if (scope === ownScope) {
      found = true;
      return '';
    }
    return whole;
  });
  const key = { scope: found ? ('scoped' as const) : ('global' as const), selector: normalizeSelector(stripped) };
  assert(key.selector.length <= selectorText.length + 64, 'selectorKeyOf: normalizing adds little');
  assert(ownScope.length > 0, 'selectorKeyOf: an own scope is never empty');
  return key;
}

/** Whether a stylesheet's path (Vite's `data-vite-dev-id`, or a link's pathname) is `source`'s: the same
 *  project-relative path at the end, after its query. Vite's id is absolute on Desktop and in Studio's
 *  container, so the tail is what both share. */
export function sheetPathIsSource(sheetPath: string, source: string): boolean {
  assert(source.length > 0, 'sheetPathIsSource: a source is never empty');
  assert(!source.startsWith('/'), 'sheetPathIsSource: a source is project-relative');
  const queryAt = sheetPath.indexOf('?');
  const path = (queryAt < 0 ? sheetPath : sheetPath.slice(0, queryAt)).replace(/\\/g, '/');
  if (path === source) {
    return true;
  }
  if (path.endsWith(`/${source}`)) {
    return true;
  }
  // `public/` is served from the site root: `public/styles/site.css` is `/styles/site.css`.
  if (source.startsWith('public/')) {
    return path === `/${source.slice('public/'.length)}`;
  }
  return false;
}

/** Whether a stylesheet's path is a `<style>` block Astro compiled from an `.astro` file
 *  (`Card.astro?astro&type=style&index=0&lang.css`): the only kind that carries a scope of its own. */
export function sheetPathIsAstroStyle(sheetPath: string): boolean {
  const queryAt = sheetPath.indexOf('?');
  if (queryAt < 0) {
    return false;
  }
  const query = new URLSearchParams(sheetPath.slice(queryAt + 1));
  assert(queryAt < sheetPath.length, 'sheetPathIsAstroStyle: the query starts inside the path');
  assert(query instanceof URLSearchParams, 'sheetPathIsAstroStyle: the query parses');
  return sheetPath.slice(0, queryAt).endsWith('.astro') && query.has('astro') && query.get('type') === 'style';
}

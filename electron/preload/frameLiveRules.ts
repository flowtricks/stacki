// The frame's half of live rule previews (shared/properties/liveRules.ts), shared
// by Desktop's preload (frameQueries.ts) and Studio's preview client: sets the
// edited declaration on the matching rules of the stylesheet compiled from the
// rule's own source file, remembers what each rule held before, and puts that
// back when the edit did not land or when the settle window runs out.
//
// An in-place CSSOM change outlives a failed save: no re-render arrives, and
// refreshDevStyles (electron/previewClient/morphAssets.ts) leaves a stylesheet
// whose text did not change alone, so a patch nobody restores would stay on the
// canvas. Every patch here therefore ends one of three ways: the page replaces
// the sheet with one that holds the value itself (settled), the app says the
// edit did not land (restored), or `settleFramesMax` frames pass (restored).

import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import {
  LIVE_RULE_LIMITS,
  isConditionAtRule,
  liveRuleKey,
  normalizeAtRule,
  parseLiveRuleMessage,
  selectorKeyOf,
  sheetPathIsAstroStyle,
  sheetPathIsSource,
  sheetScopeOf,
  sourceSelectorKey,
  type LiveRuleEdit,
  type LiveRuleTarget,
} from '../../shared/properties/liveRules';

/** One rule this module changed, and what it held before. */
interface Patch {
  readonly rule: CSSStyleRule;
  readonly value: string;
  readonly priority: string;
}

interface Override {
  readonly rule: LiveRuleTarget;
  readonly edit: LiveRuleEdit;
  /** Set once the save landed: the edit the page's own sheet must hold before this goes. */
  readonly until: LiveRuleEdit | undefined;
  readonly framesWaited: number;
}

/** Why a stylesheet could not be searched. */
export interface LiveRuleProblem {
  readonly code: 'rules-over-cap';
  readonly message: string;
}

const overrides = new Map<string, Override>();
// The rules each preview changed, by the preview's key. Owned by this module alone, which
// is the one place that writes the CSSOM; patches of sheets the page has replaced are pruned.
const patchesByKey = new Map<string, readonly Patch[]>();
let settleScheduled = false;

/** Applies an app message if it is one; false when it was something else. */
export function receiveLiveRules(input: unknown): boolean {
  const message = parseLiveRuleMessage(input);
  if (message === undefined) {
    return false;
  }
  const key = liveRuleKey(message.rule);
  switch (message.op) {
    case 'set': {
      if (!overrides.has(key)) {
        makeRoom();
      }
      overrides.delete(key); // Re-inserted last, so the map stays in edit order.
      overrides.set(key, { rule: message.rule, edit: message.edit, until: undefined, framesWaited: 0 });
      patch(key, message.rule, message.edit);
      break;
    }
    case 'drop': {
      const override = overrides.get(key);
      if (override === undefined) {
        break;
      }
      if (message.until === undefined) {
        restore(key, override.rule.property);
        overrides.delete(key);
      } else {
        overrides.set(key, { ...override, edit: message.until, until: message.until, framesWaited: 0 });
        scheduleSettle();
      }
      break;
    }
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
  assert(overrides.size <= LIVE_RULE_LIMITS.entriesMax, 'receiveLiveRules: previews stay bounded');
  assert(patchesByKey.size <= overrides.size, 'receiveLiveRules: patches belong to held previews');
  return true;
}

/** How many previews are held: for tests, which check that nothing outlives its window. */
export function liveRuleCount(): number {
  return overrides.size;
}

// Full: the oldest edit is the one least likely still under a finger, and its rules get their own values back.
function makeRoom(): void {
  if (overrides.size < LIVE_RULE_LIMITS.entriesMax) {
    return;
  }
  const [oldestKey, oldest] = overrides.entries().next().value ?? [];
  assert(oldestKey !== undefined, 'makeRoom: a full map has an oldest entry');
  assert(oldest !== undefined, 'makeRoom: the oldest entry has a value');
  restore(oldestKey, oldest.rule.property);
  overrides.delete(oldestKey);
}

// Sets `edit` on every matching rule, recording each rule's own value the first time it is touched.
function patch(key: string, target: LiveRuleTarget, edit: LiveRuleEdit): void {
  const patches = [...livePatches(key)];
  const found = matchingRules(document, target);
  if (!found.ok) {
    reportOnce(found.error);
    return;
  }
  for (const rule of found.value) {
    if (!patches.some((entry) => entry.rule === rule)) {
      if (patches.length < LIVE_RULE_LIMITS.patchesMax) {
        patches.push({ rule, value: rule.style.getPropertyValue(target.property), priority: rule.style.getPropertyPriority(target.property) });
      } else {
        continue; // Unrecorded rules are never written: every change here must be restorable.
      }
    }
    write(rule, target.property, edit);
  }
  assert(patches.length <= LIVE_RULE_LIMITS.patchesMax, 'patch: patches stay bounded');
  setPatches(key, patches);
}

// Puts back what each still-attached rule held, newest first, and forgets the patches.
function restore(key: string, property: string): void {
  const patches = livePatches(key);
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const entry = patches[index];
    assert(entry !== undefined, 'restore: index within patches');
    if (entry.value === '') {
      entry.rule.style.removeProperty(property);
    } else {
      entry.rule.style.setProperty(property, entry.value, entry.priority);
    }
  }
  patchesByKey.delete(key);
}

// The patches of `key` whose rules are still on the page; the rest went with their sheets.
function livePatches(key: string): readonly Patch[] {
  const patches = patchesByKey.get(key) ?? [];
  const live = patches.filter((entry) => attached(entry.rule));
  setPatches(key, live);
  return live;
}

function setPatches(key: string, patches: readonly Patch[]): void {
  if (patches.length === 0) {
    patchesByKey.delete(key);
  } else {
    patchesByKey.set(key, patches);
  }
}

function write(rule: CSSStyleRule, property: string, edit: LiveRuleEdit): void {
  switch (edit.kind) {
    case 'value':
      rule.style.setProperty(property, edit.value, edit.important ? 'important' : '');
      return;
    case 'removed':
      rule.style.removeProperty(property);
      return;
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

// A rule still in the document: its sheet is the one its owner element shows. Replacing a
// <style>'s text gives the element a new sheet and detaches the old one with its rules.
function attached(rule: CSSStyleRule): boolean {
  const sheet = rule.parentStyleSheet;
  if (sheet === null) {
    return false;
  }
  const owner = sheet.ownerNode;
  if (owner === null) {
    return false;
  }
  if (!owner.isConnected) {
    return false;
  }
  return 'sheet' in owner && owner.sheet === sheet;
}

// ───────────────────────────── Settling ─────────────────────────────

function scheduleSettle(): void {
  if (settleScheduled) {
    return;
  }
  settleScheduled = true;
  requestAnimationFrame(settle);
}

// Each released preview is checked once per frame, before the frame paints. It goes when every
// matching rule is the page's own (none patched) and holds the written value. Until then, a
// fresh sheet that does not hold it yet (an older save's render) is patched again, so the swap
// never shows the old value; and once the window is spent, the page's own values come back.
function settle(): void {
  settleScheduled = false;
  for (const [key, override] of [...overrides]) {
    const until = override.until;
    if (until === undefined) {
      continue;
    }
    const patches = livePatches(key);
    const found = matchingRules(document, override.rule);
    const rules = found.ok ? found.value : [];
    if (patches.length === 0) {
      if (rules.every((rule) => holds(rule, override.rule.property, until))) {
        overrides.delete(key); // Settled, or the rule is gone: nothing of ours is left on the page.
        continue;
      }
    }
    if (override.framesWaited + 1 >= LIVE_RULE_LIMITS.settleFramesMax) {
      restore(key, override.rule.property);
      overrides.delete(key);
      continue;
    }
    overrides.set(key, { ...override, framesWaited: override.framesWaited + 1 });
    patch(key, override.rule, until);
  }
  if ([...overrides.values()].some((override) => override.until !== undefined)) {
    scheduleSettle();
  }
}

// Whether a rule the page itself wrote already holds `edit`, compared in the browser's own
// serialization (`#F00` and `rgb(255, 0, 0)` are the same colour).
function holds(rule: CSSStyleRule, property: string, edit: LiveRuleEdit): boolean {
  const value = rule.style.getPropertyValue(property);
  switch (edit.kind) {
    case 'removed':
      return value === '';
    case 'value': {
      if (value !== canonicalValue(property, edit.value)) {
        return false;
      }
      return (rule.style.getPropertyPriority(property) === 'important') === edit.important;
    }
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

let scratch: CSSStyleDeclaration | undefined = undefined;

function canonicalValue(property: string, value: string): string {
  scratch ??= document.createElement('div').style;
  scratch.removeProperty(property);
  scratch.setProperty(property, value);
  const canonical = scratch.getPropertyValue(property);
  scratch.removeProperty(property);
  return canonical === '' ? value.trim() : canonical;
}

// ───────────────────────────── Finding rules ─────────────────────────────

const reported = new WeakSet<CSSStyleSheet>();
const problems: LiveRuleProblem[] = [];

// A sheet too large to index is skipped, loudly: once per sheet in the console, and in
// `liveRuleProblems` for tests. The save still shows the edit, at the old speed.
function reportOnce(problem: LiveRuleProblem & { readonly sheet: CSSStyleSheet }): void {
  if (reported.has(problem.sheet)) {
    return;
  }
  reported.add(problem.sheet);
  if (problems.length < LIVE_RULE_LIMITS.entriesMax) {
    problems.push({ code: problem.code, message: problem.message });
  }
  console.warn(`Stacki live rule preview: ${problem.message}`);
}

/** The problems reported so far, oldest first. */
export function liveRuleProblems(): readonly LiveRuleProblem[] {
  return problems;
}

/**
 * The rules `target` names in `page`: style rules in the stylesheets compiled from its source
 * file, under the same conditions, with the same selector. A sheet over `sheetRulesMax` rules
 * is an error rather than a partial answer, which would silently miss rules.
 */
export function matchingRules(page: Document, target: LiveRuleTarget): Result<readonly CSSStyleRule[], LiveRuleProblem & { readonly sheet: CSSStyleSheet }> {
  const context = target.context.filter(isConditionAtRule).map(normalizeAtRule).join('\n');
  const wanted = sourceSelectorKey(target.selector);
  const rules: CSSStyleRule[] = [];
  for (let sheetAt = 0; sheetAt < page.styleSheets.length; sheetAt += 1) {
    const sheet = page.styleSheets.item(sheetAt);
    if (sheet === null) {
      continue;
    }
    const sheetPath = sheetPathOf(sheet);
    if (sheetPath === undefined) {
      continue;
    }
    if (!sheetPathIsSource(sheetPath, target.source)) {
      continue;
    }
    const index = sheetIndex(sheet, sheetPath);
    if (index === undefined) {
      continue;
    }
    if (index.kind === 'over-cap') {
      const message = `${target.source} has more than ${LIVE_RULE_LIMITS.sheetRulesMax} rules in one stylesheet; edits show once saved.`;
      return err({ code: 'rules-over-cap', message, sheet });
    }
    const scope = index.scoped ? wanted.scope : 'global';
    for (const rule of index.rules.get(indexKey(context, scope, wanted.selector)) ?? []) {
      if (rule.parentStyleSheet === sheet) {
        rules.push(rule); // A rule deleted through the CSSOM since indexing has no sheet.
      }
    }
  }
  assert(rules.length <= LIVE_RULE_LIMITS.sheetRulesMax, 'matchingRules: bounded by the index');
  return ok(rules);
}

// The file a stylesheet was compiled from: Vite's id for a dev <style>, or a link's path.
function sheetPathOf(sheet: CSSStyleSheet): string | undefined {
  const owner = sheet.ownerNode;
  if (owner === null || !('getAttribute' in owner)) {
    return undefined;
  }
  const devId = owner.getAttribute('data-vite-dev-id');
  if (devId !== null) {
    return devId;
  }
  if (sheet.href === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(new URL(sheet.href).pathname);
  } catch {
    return undefined; // A malformed href names no file of the project.
  }
}

// ───────────────────────────── The index ─────────────────────────────

// Rules indexed by context and selector, per stylesheet. A scrub sends a message per tick;
// walking every rule of every sheet and normalizing each selector per tick costs time in
// proportion to the whole site's CSS. The index is built once per sheet object and kept in
// a WeakMap: replacing a <style>'s text (a save landing, Vite's hot update) gives it a new
// sheet object, so a stale index is never consulted and the old one is collected with its
// sheet. Rules added later through the CSSOM (insertRule) are not seen until the sheet is
// replaced; the save then shows them at the old speed.
type SheetIndex =
  { readonly kind: 'indexed'; readonly scoped: boolean; readonly rules: ReadonlyMap<string, readonly CSSStyleRule[]> } | { readonly kind: 'over-cap' };

const indexes = new WeakMap<CSSStyleSheet, SheetIndex>();

function indexKey(context: string, scope: 'scoped' | 'global', selector: string): string {
  return `${context}\n\n${scope}\n${selector}`;
}

function sheetIndex(sheet: CSSStyleSheet, sheetPath: string): SheetIndex | undefined {
  const known = indexes.get(sheet);
  if (known !== undefined) {
    return known;
  }
  let list: CSSRuleList;
  try {
    list = sheet.cssRules;
  } catch {
    return undefined; // A cross-origin sheet cannot be read, and holds none of the project's rules.
  }
  const collected = collectStyleRules(list);
  if (collected === undefined) {
    indexes.set(sheet, { kind: 'over-cap' });
    return { kind: 'over-cap' };
  }
  // Only a block compiled from an .astro file has a scope of its own. In a plain stylesheet a
  // scope attribute is something the author wrote, and stays part of the selector.
  const ownScope = sheetPathIsAstroStyle(sheetPath) ? sheetScopeOf(collected.map((entry) => entry.rule.selectorText)) : undefined;
  const index = buildIndex(collected, ownScope);
  indexes.set(sheet, index);
  return index;
}

interface Collected {
  readonly rule: CSSStyleRule;
  readonly context: string;
}

// Iterative, bounded by sheetRulesMax visits and contextMax depth. Descends only into the
// at-rules that wrap rules without changing what they match (@media, @supports, @container,
// @layer); a rule nested in another style rule is resolved differently in source and is left
// to the save. Undefined when the sheet has more rules than the cap.
function collectStyleRules(list: CSSRuleList): readonly Collected[] | undefined {
  const collected: Collected[] = [];
  const pending: { readonly rules: CSSRuleList; readonly chain: readonly string[] }[] = [{ rules: list, chain: [] }];
  let visited = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    assert(entry !== undefined, 'collectStyleRules: stack underflow');
    for (let ruleAt = 0; ruleAt < entry.rules.length; ruleAt += 1) {
      const rule = entry.rules.item(ruleAt);
      if (rule === null) {
        continue;
      }
      visited += 1;
      if (visited > LIVE_RULE_LIMITS.sheetRulesMax) {
        return undefined;
      }
      if (isStyleRule(rule)) {
        collected.push({ rule, context: entry.chain.join('\n') });
        continue;
      }
      const prelude = groupingPrelude(rule);
      if (prelude === undefined) {
        continue;
      }
      if (!(rule instanceof CSSGroupingRule)) {
        continue;
      }
      if (entry.chain.length < LIVE_RULE_LIMITS.contextMax) {
        const chain = isConditionAtRule(prelude) ? [...entry.chain, normalizeAtRule(prelude)] : entry.chain;
        pending.push({ rules: rule.cssRules, chain });
      }
    }
  }
  assert(visited <= LIVE_RULE_LIMITS.sheetRulesMax, 'collectStyleRules: visits stay under the cap');
  return collected;
}

function buildIndex(collected: readonly Collected[], ownScope: string | undefined): SheetIndex {
  const rules = new Map<string, CSSStyleRule[]>();
  for (const entry of collected) {
    const key = selectorKeyOf(entry.rule.selectorText, ownScope);
    const indexed = indexKey(entry.context, key.scope, key.selector);
    const bucket = rules.get(indexed);
    if (bucket === undefined) {
      rules.set(indexed, [entry.rule]);
    } else {
      bucket.push(entry.rule);
    }
  }
  assert(rules.size <= collected.length, 'buildIndex: one key per rule at most');
  return { kind: 'indexed', scoped: ownScope !== undefined, rules };
}

// Rule kinds by their standard type names, so the frame's own window decides and a test
// window (jsdom) that lacks a class has no such rules either.
function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return rule.constructor.name === 'CSSStyleRule' && 'selectorText' in rule && 'style' in rule;
}

function groupingPrelude(rule: CSSRule): string | undefined {
  switch (rule.constructor.name) {
    case 'CSSMediaRule':
      return 'media' in rule && rule.media instanceof Object && 'mediaText' in rule.media ? `@media ${String(rule.media.mediaText)}` : undefined;
    case 'CSSSupportsRule':
      return 'conditionText' in rule ? `@supports ${String(rule.conditionText)}` : undefined;
    case 'CSSContainerRule':
      return 'conditionText' in rule ? `@container ${String(rule.conditionText)}` : undefined;
    case 'CSSLayerBlockRule':
      return 'name' in rule ? `@layer ${String(rule.name)}` : undefined;
    default:
      return undefined;
  }
}

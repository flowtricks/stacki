// The style editor's model, outside React: streaming the documents a page and
// its components style, the chips a selection shows, where a write lands, the
// scan's state and signature, and the session caches that keep a scan and a
// view across remounts (EmbedEditor.tsx).

import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import { type RuleModel } from '../model/cascade';
import { snapshotTokens, tokensToSelector } from '../model/elementTokens';
import { chipLayer, selectorKey, selectorsMatch, stateForSelector, STATES, type MatchedSelector, type PanelLayer, type StyleContext } from '../model/resolved';
import type { Declaration } from 'postcss';
import {
  directDecls,
  createRuleAtRoot,
  createRuleInAtRule,
  createNestedRule,
  createRuleInMedia,
  createRuleInQuery,
  createRuleInPlacedQuery,
  listAtRuleBlocks,
  parseNestedInput,
  type NestStep,
} from '../model/css';
import {
  canonicalCompound,
  compareSpecificity,
  isGlobalSelector,
  normalizePseudoElement,
  selectorDependsOnAncestor,
  selectorListLayers,
  selectorSpecificity,
} from '../model/selectors';
import { findNode, getHost, onHostChange, propText, type HostNode } from '../model/host';
import {
  dedupeByKey,
  loadEmbedDocs,
  readNativeStyles,
  resolveIdentityElement,
  askCanvasAbout,
  resolveTarget,
  scanAllComponents,
  serializeElementId,
  writeEmbedDocument,
  type EmbedDocument,
  type EmbedScan,
  type PageScan,
} from '../model/webflow';
import type { ElementSnapshot, NativeModel, ParsedRule } from '../model/styleTypes';
import { type ScanState, type PropWrite, EMPTY_RULE_MODEL, type Placeholder, computePlaceholders } from './EditorBasics';
import { selectorOrder, styledSelectorsFor } from './editorSignatures';
import { withInstanceChips, writableRegion } from '../model/instanceClasses';
import { writtenInMarkup, type ComponentMarkup } from '../model/componentMarkup';
export {
  BG_REFRESH_THROTTLE_MS,
  sheetSignature,
  DESIGNER_SYNC_INTERVAL_MS,
  selectorKeyOf,
  snapshotSignature,
  nativeSignature,
  chainPrefixDepth,
  selectorOrder,
  styledSelectorsFor,
} from './editorSignatures';

// Stream: accumulate docs as each embed is read and render them right away, rather
// than waiting for the whole batch. Emits are coalesced (≤ ~1/100ms) so the re-resolve
// per partial can't thrash. Dedupe by key because a page and component scan can
// surface the same embed. Returns the per-document callback.
export function streamDocs(pageScan: EmbedScan, onPartial: ((content: Content) => void) | undefined): (embedDocument: EmbedDocument) => void {
  const streamed: EmbedDocument[] = [];
  const streamedKeys = new Set<string>();
  let lastEmitAt = 0;
  return (embedDocument) => {
    if (streamedKeys.has(embedDocument.source.key)) {
      return;
    }
    streamedKeys.add(embedDocument.source.key);
    streamed.push(embedDocument);
    if (!onPartial) {
      return;
    }
    const now = Date.now();
    if (now - lastEmitAt < 100) {
      return;
    }
    lastEmitAt = now;
    onPartial({
      scan: pageScan,
      docs: [...streamed],
      rules: [],
      errors: [],
      embedCount: 0,
      componentEmbedCount: 0,
      partial: true,
    });
  };
}

// The component embeds, read fresh on every build. Which sources exist depends
// on the file open: its own <style> blocks come from the model and its file is
// left out of the disk-read list. A list cached while the page was open kept the
// page's <style> and a second, disk-read copy of the component after drilling in,
// so edits went to blocks the open file does not hold (issue #72). Listing is
// in-memory work; only the reads touch disk, and those always ran.
export async function loadComponentDocs(onDocument: (embedDocument: EmbedDocument) => void): Promise<{ docs: EmbedDocument[]; errors: Content['errors'] }> {
  const docs: EmbedDocument[] = [];
  const errors: Content['errors'] = [];
  await scanAllComponents(async (embeds) => {
    const result = await loadEmbedDocs(embeds, onDocument);
    docs.push(...result.docs);
    errors.push(...result.errors);
  });
  return { docs, errors };
}

// The full scan's content: page docs then component docs, each embed once.
export function mergedContent(pageScan: EmbedScan, results: ReadonlyArray<{ docs: EmbedDocument[]; errors: Content['errors'] }>): Content {
  const seenDocs = new Set<string>();
  const docs = results
    .flatMap((result) => result.docs)
    .filter((embedDocument) => {
      if (seenDocs.has(embedDocument.source.key)) {
        return false;
      }
      seenDocs.add(embedDocument.source.key);
      return true;
    });
  const embeds = dedupeByKey(docs.map((embedDocument) => embedDocument.source));
  return {
    scan: { ...pageScan, embeds },
    docs,
    rules: [],
    errors: results.flatMap((result) => result.errors),
    embedCount: 0,
    componentEmbedCount: 0,
    partial: false,
  };
}

// The query scaffolds for an element's classes — only inside a component, from its own
// (writable) embeds.
export function placeholdersFor(content: Content, classList: string[]): Placeholder[] {
  return content.scan.inComponentContext ? computePlaceholders(content.docs, classList) : [];
}

// What the Designer says about the selected element now: its match target and
// snapshot, its native class styles, and the canvas's answer the target came from.
// Undefined on a transient read failure.
export async function readDesignerState(element: unknown, content: Content) {
  try {
    const asked = await askCanvasAbout(serializeElementId(element), content.rules);
    const resolved = await resolveTarget(element, content.scan, asked);
    // Read from the RESOLVED identity element (as refreshNative and the load effect
    // do), NOT the raw selection — reading the raw element yields a different model
    // for in-component selections, so its signature would never match the displayed
    // one and the poll would re-render every tick.
    const identity = await resolveIdentityElement(element);
    const native = await readNativeStyles(identity, STATES);
    return { target: resolved.target, snap: resolved.rootSnapshot, native, asked };
  } catch {
    return undefined;
  }
}

// A lone class typed into the selector box should also land on the element, the way a
// class field would. Anything more — a combinator, :is(), a state, a second token — is
// a selector being authored deliberately, so the element is left alone.
// canonicalCompound already draws that line. Returns the class name, if it is one.
export function loneTypedClass(selector: string): string | undefined {
  const canon = canonicalCompound(selector);
  if (!canon.simple || !canon.oneCompound || canon.pseudoElement) {
    return undefined;
  }
  if (canon.pseudoClasses.length !== 0 || canon.tokens.length !== 1) {
    return undefined;
  }
  const token = canon.tokens[0] ?? '';
  return token.startsWith('class:') ? token.slice('class:'.length) : undefined;
}

export interface ChipInputs {
  model: RuleModel | undefined;
  nativeModel: NativeModel | undefined;
  currentContext: StyleContext;
  activeSelector: string;
  selectedSelectorText: string | undefined;
  tokens: ReturnType<typeof snapshotTokens>;
  classList: string[];
  removedClasses: ReadonlySet<string>;
  /** Which box the list is for: the element unless a layer is named (usePanelLayer). */
  pseudo?: PanelLayer | undefined;
  /** Classes the instance passed to the component open on the canvas, offered as
   *  chips of their own (model/instanceClasses.ts). Empty outside a component. */
  instanceClasses?: readonly string[] | undefined;
  /** What the element's node writes in the open component file, which makes a chip
   *  green (model/componentMarkup.ts). Undefined on a page: nothing is green there. */
  componentMarkup?: ComponentMarkup | undefined;
  /** Nested selectors as they were typed, for chips with no rule yet (withTypedLabel). */
  typedLabels?: TypedLabels | undefined;
}

/** A pseudo-element the navigator shows as a layer of its own. */
export type PseudoTarget = '::before' | '::after';

/**
 * The chips of one box: a rule styling `::after` is about that box, not the element,
 * and shows on its navigator row and nowhere else. Bounded by `list`.
 */
export function pseudoLayerChips(list: readonly MatchedSelector[], layer: PanelLayer): MatchedSelector[] {
  const shown = layer === 'every' ? [...list] : list.filter((entry) => chipLayer(entry) === layer);
  assert(shown.length <= list.length, 'pseudoLayerChips: a filter never adds');
  return shown;
}

// Every selector (with styles) that targets the element in the current context, for
// the chip picker, in chip display order.
export function chipsFor(inputs: ChipInputs): MatchedSelector[] {
  const { model, nativeModel, currentContext, removedClasses } = inputs;
  // Show EVERY selector that styles this element in any query. The picker dims the
  // ones not styled in the current query (inContext === false) rather than hiding
  // them — so switching queries keeps the full list visible instead of dropping
  // selectors that only have styles elsewhere.
  // A chip is a selector that targets THIS element. One that hangs off a class the
  // element no longer has doesn't any more — drop it now instead of leaving it in
  // the well until the next resolve. Complex selectors are left to that resolve:
  // the class may be an ancestor's, which this can't tell apart.
  const styled = styledSelectorsFor(model, nativeModel, currentContext).filter((entry) => {
    if (!removedClasses.size) {
      return true;
    }
    const canon = canonicalCompound(entry.text);
    return !(canon.simple && canon.tokens.some((tok) => removedClasses.has(tok)));
  });
  // Inside a component opened from an instance, the classes that instance passed
  // (`column1Class="hero_copy"`) are the element's too: chips of their own, even
  // before any rule styles them, so they can be picked. Added before the pending
  // chip, which then never doubles one.
  const list = withInstanceChips(styled, inputs.instanceClasses ?? []);
  const pending = pendingActiveChip(list, inputs);
  if (pending) {
    list.push(pending);
  }
  // A ::before or ::after layer picked in the navigator is its own target: only
  // the selectors that style that pseudo-element are about it, so the element's
  // own (`.stat_wrap`) and the other pseudo-element's are left out. The element's
  // list likewise leaves out its pseudo-elements'. A pseudo-element selector typed
  // on the element's row is the exception: it is the target, so its chip stays.
  const layered = pseudoLayerChips(list, inputs.pseudo ?? '');
  const typed = list.filter((entry) => chipLayer(entry) !== '' && !layered.includes(entry) && selectorsMatch(entry.text, inputs.activeSelector));
  // A chip is the component's (green) when the markup writes what it needs; an
  // instance's class is never written there, so its chip is not.
  const shown = [...layered, ...typed].map((entry) => (writtenInMarkup(entry.text, inputs.componentMarkup) ? { ...entry, inComponentMarkup: true } : entry));
  // The well reads broadest first (wellOrder): the styled tag, the global chips
  // (`:target`, `*`), the component's chips together, then the element's classes and
  // the nested selectors, each group least specific first. A specificity tie keeps the
  // readable order (inChipOrder): base class + pseudos → applied combo chain + pseudos
  // → other classes → data attributes → complex selectors.
  return wellOrder(inChipOrder(shown, inputs.classList, { byOrder: true })).map((selector) =>
    // In a query context, show the display with an `@` at the query position;
    // on Base / other contexts show the plain nested display.
    currentContext.embedAtContext && selector.inContext !== false && selector.queryDisplay ? { ...selector, display: selector.queryDisplay } : selector,
  );
}

// Show the active selector as a pending (dashed/outlined) chip while it has no rule
// yet, so a freshly typed/picked selector stays visible until its first property
// lands (then it becomes a solid styled chip). We show it for a complex/typed
// selector always, and for the element's OWN classes only when the user explicitly
// typed or picked one (`selectedSelectorText` set) — the AUTO-composed default
// (`.card`, `div`) stays hidden since its token chip already indicates the pick.
// Switching elements/selectors clears `selectedSelectorText` + the active selector,
// so the pending chip disappears on its own when you move on without adding styles.
export function pendingActiveChip(
  list: MatchedSelector[],
  inputs: Pick<ChipInputs, 'activeSelector' | 'selectedSelectorText' | 'tokens' | 'typedLabels'>,
): MatchedSelector | undefined {
  const { activeSelector } = inputs;
  if (!activeSelector || list.some((entry) => selectorsMatch(entry.text, activeSelector))) {
    return undefined;
  }
  const ownTokens = new Set(inputs.tokens.map((token) => token.name));
  const canon = canonicalCompound(activeSelector);
  const own = canon.simple && canon.tokens.every((tok) => ownTokens.has(tok));
  if (own && inputs.selectedSelectorText === undefined) {
    return undefined;
  }
  // No rule means no nesting to read back yet, so the typed text is the only
  // record of it; without this the chip showed the flattened `.a .b`.
  const typedLabel = inputs.typedLabels?.get(selectorKey(activeSelector));
  return {
    text: activeSelector,
    ...(typedLabel === undefined ? {} : { display: typedLabel }),
    // Ranked like any chip in the well (wellOrder), by what its text weighs.
    specificity: selectorSpecificity(activeSelector),
    state: stateForSelector(activeSelector),
    simple: canon.simple,
    key: `active:${activeSelector}`,
    pending: true,
    inContext: true,
    fromComponent: false,
  };
}

/**
 * The well's order, broadest first, in four groups:
 *
 * 1. The element's tag, when a rule styles it. It names what the element is, the way
 *    the Style header (`h2.heading`) does; an unstyled tag (a pending chip) has no
 *    values to show, so it takes its place in the groups below like any other.
 * 2. The global chips (`:target`, `:focus-visible`, `*`: no class, id or
 *    attribute and no ancestor; the grey `is-global` chips, LayoutRows.tsx). They
 *    match any element, so they are broader than anything naming this one.
 * 3. The component's chips (the green ones: what they need is written in the open
 *    component's markup, inComponentMarkup), kept together: the component's classes
 *    are the base the page's own build on, and a green chip scattered among blue
 *    ones hid which classes come with the component.
 * 4. Every other chip: the element's classes, attributes, then compound and nested
 *    selectors, which specificity puts last on its own.
 *
 * Inside each group chips run from least specific to most, so the group builds up
 * the way the cascade does and its winning chip is read last. Across groups the
 * grouping comes first; a chip of an earlier group may outweigh a later one.
 */
export function wellOrder<Chip extends Pick<MatchedSelector, 'specificity' | 'text' | 'pending' | 'inComponentMarkup'>>(chips: readonly Chip[]): Chip[] {
  const sorted = bySpecificity(chips);
  const tag = sorted.find((chip) => chip.pending !== true && isBareTagSelector(chip.text));
  // Both sorts are stable, so a group keeps the specificity order bySpecificity gave it.
  const ranked = sorted.map((chip) => ({ chip, group: wellGroup(chip, tag) }));
  const ordered = [...ranked].sort((left, right) => left.group - right.group);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    assert(previous !== undefined, 'wellOrder: the previous chip is in range');
    assert(current !== undefined, 'wellOrder: the current chip is in range');
    if (previous.group === current.group) {
      assert(compareSpecificity(previous.chip.specificity, current.chip.specificity) <= 0, 'wellOrder: a group runs least specific first');
    } else {
      assert(previous.group < current.group, 'wellOrder: the groups come in order');
    }
  }
  const result = ordered.map((entry) => entry.chip);
  assert(result.length === chips.length, 'wellOrder: every chip is kept');
  assert(tag === undefined || result[0] === tag, 'wellOrder: a styled tag leads');
  return result;
}

/** Which of wellOrder's groups a chip reads in: tag 0, global 1, component 2, other 3. */
function wellGroup(chip: Pick<MatchedSelector, 'text' | 'inComponentMarkup'>, tag: unknown): number {
  if (chip === tag) {
    return 0;
  }
  if (chip.inComponentMarkup === true) {
    return 2;
  }
  return isWellGlobal(chip.text) ? 1 : 3;
}

/** Whether a chip is global in the well's sense: the grey `is-global` chip (classifySelector). */
function isWellGlobal(text: string): boolean {
  return isGlobalSelector(text) && !selectorDependsOnAncestor(text);
}

/** Whether a selector is the element's tag alone (`h2`): no class, attribute or pseudo. */
export function isBareTagSelector(text: string): boolean {
  const canon = canonicalCompound(text);
  if (!canon.oneCompound) {
    return false;
  }
  if (canon.pseudoClasses.length > 0 || canon.pseudoElement !== '' || canon.functional) {
    return false;
  }
  return canon.tokens.length === 1 && (canon.tokens[0] ?? '').startsWith('tag:');
}

/**
 * Chips from least specific to most, (a, b, c) compared in turn. The sort is
 * stable, so chips of equal specificity keep the order they came in (inChipOrder,
 * which falls back to source order). The well is one list, not groups: global and
 * inherited chips keep their colour and filter wherever they land.
 */
export function bySpecificity<Chip extends Pick<MatchedSelector, 'specificity'>>(chips: readonly Chip[]): Chip[] {
  const sorted = [...chips].sort((left, right) => compareSpecificity(left.specificity, right.specificity));
  assert(sorted.length === chips.length, 'bySpecificity: a sort keeps every chip');
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    assert(previous !== undefined, 'bySpecificity: the previous chip is in range');
    assert(current !== undefined, 'bySpecificity: the current chip is in range');
    assert(compareSpecificity(previous.specificity, current.specificity) <= 0, 'bySpecificity: no chip is weaker than the one before it');
  }
  return sorted;
}

// Selectors in readable order (see selectorOrder), then by specificity; with
// `byOrder`, a selector's own source order breaks the tie before its text does. The
// well ranks this list by specificity (wellOrder); this order settles its ties.
export function inChipOrder(selectors: MatchedSelector[], classList: string[], { byOrder }: { readonly byOrder: boolean }): MatchedSelector[] {
  return selectors
    .map((entry) => ({ s: entry, rank: selectorOrder(entry.text, classList) }))
    .sort(
      (left, right) =>
        left.rank[0] - right.rank[0] ||
        left.rank[1] - right.rank[1] ||
        left.rank[2] - right.rank[2] ||
        compareSpecificity(left.s.specificity, right.s.specificity) ||
        (byOrder && left.s.order !== undefined && right.s.order !== undefined ? left.s.order - right.s.order : 0) ||
        left.s.text.localeCompare(right.s.text),
    )
    .map((ranked) => ranked.s);
}

// The selector a new element's default upgrades to, from the local selectors styled in
// the current context — or undefined to keep the default, when it is already styled.
export function upgradedDefault(
  local: MatchedSelector[],
  element: {
    tokens: ReturnType<typeof snapshotTokens>;
    classList: string[];
    defaultTokens: string[];
  },
): MatchedSelector | undefined {
  const { tokens, classList } = element;
  const defaultSelector = tokensToSelector(element.defaultTokens, tokens);
  if (defaultSelector && local.some((entry) => selectorsMatch(entry.text, defaultSelector))) {
    return undefined;
  }
  // Fall back to the FIRST applied class that has styles (the primary block class in
  // Lumos) rather than styled[last] — utility classes (u-*) sort last by name and
  // shouldn't win the default just because their specificity ties the base class.
  //
  // Every class, not just the defaulted one: the default is now the first class
  // alone, and if THAT one has no styles the next one along is still a better
  // answer than a selector picked by specificity.
  const primaryStyled = tokens
    .filter((token) => token.kind === 'class')
    .map((token) => token.name)
    .flatMap((tok) => {
      const found = local.find((entry) => selectorsMatch(entry.text, tokensToSelector([tok], tokens)));
      return found ? [found] : [];
    })[0];
  // Otherwise the FIRST selector in chip display order after the tag — the element's
  // own class/nesting selector (`.hero_component > .hero_paragraph`), not the highest-
  // specificity one (a foreign `:not(…) > :is(…)` shouldn't win the default).
  const ordered = inChipOrder([...local], classList, { byOrder: false });
  const firstAfterTag = ordered.find((entry) => selectorOrder(entry.text, classList)[0] > 0);
  return primaryStyled ?? firstAfterTag ?? ordered[0] ?? local[local.length - 1];
}

export type EmbedRegion = EmbedDocument['regions'][number];

// Where a new rule is written: the chosen embed when one is selected, otherwise the
// embed of a matching rule (in the current context, when `inContext` is given) or the
// first embed. The region is the anchor rule's block when it lives in the target doc,
// else that doc's first block. Undefined when there's no embed to write into.
export function embedWriteTarget(
  target: {
    model: RuleModel | undefined;
    selectedEmbedKey: string | undefined;
    documentByKey: Map<string, EmbedDocument>;
  },
  inContext: ((rule: ParsedRule) => boolean) | undefined,
): { embedDocument: EmbedDocument; region: EmbedRegion } | undefined {
  const { model, selectedEmbedKey, documentByKey } = target;
  const matched = model ? [...model.base, ...model.conditional].map((entry) => entry.rule) : [];
  const ofSelected = (rule: ParsedRule) => rule.embedKey === selectedEmbedKey;
  let anchor: ParsedRule | undefined;
  if (inContext === undefined) {
    anchor = selectedEmbedKey ? matched.find(ofSelected) : matched[0];
  } else if (selectedEmbedKey) {
    anchor = matched.find((rule) => ofSelected(rule) && inContext(rule)) ?? matched.find(ofSelected);
  } else {
    anchor = matched.find(inContext) ?? matched[0];
  }
  const embedDocument = selectedEmbedKey ? documentByKey.get(selectedEmbedKey) : anchor ? documentByKey.get(anchor.embedKey) : [...documentByKey.values()][0];
  // With no rule of its own to join, a new rule goes into the first global
  // block of the source (see writableRegion), because a scoped block would hash
  // the selector away from the element it was written for.
  const region =
    anchor && embedDocument && anchor.embedKey === embedDocument.source.key
      ? embedDocument.regions[anchor.regionIndex]
      : embedDocument === undefined
        ? undefined
        : writableRegion(embedDocument.regions);
  return embedDocument && region ? { embedDocument, region } : undefined;
}

/**
 * Where a new rule in a query context goes. A context listed from a stylesheet
 * names it (model/queryWrapper.ts): that stylesheet, at the region holding the
 * context's block. Otherwise, for a nested context, the chosen stylesheet when it
 * holds the block, else the first that does; else the chosen stylesheet, where
 * the block is then built. Undefined only when there is no stylesheet at all.
 */
export function placedQueryTarget(
  chosen: { embedDocument: EmbedDocument; region: EmbedRegion } | undefined,
  documents: ReadonlyMap<string, EmbedDocument>,
  query: { readonly atContextKey: string; readonly wrapper: string | undefined; readonly source: string | undefined },
): { embedDocument: EmbedDocument; region: EmbedRegion } | undefined {
  const holds = (region: EmbedRegion) =>
    listAtRuleBlocks(region).some((block) => {
      if (block.atContext.join(' › ') !== query.atContextKey) {
        return false;
      }
      if (query.wrapper === undefined) {
        return block.placement.kind === 'top-level';
      }
      return block.placement.kind === 'nested' && block.placement.wrapper === query.wrapper;
    });
  const named = query.source === undefined ? undefined : documents.get(query.source);
  if (named !== undefined) {
    const region = named.regions.find(holds) ?? named.regions[0];
    return region === undefined ? chosen : { embedDocument: named, region };
  }
  if (query.wrapper === undefined) {
    return chosen;
  }
  const ordered =
    chosen === undefined ? [...documents.values()] : [chosen.embedDocument, ...[...documents.values()].filter((document) => document !== chosen.embedDocument)];
  for (const embedDocument of ordered) {
    const region = embedDocument.regions.find(holds);
    if (region !== undefined) {
      return { embedDocument, region };
    }
  }
  return chosen;
}

// Create the rule for a write: typed nested syntax writes real nested source; a
// Webflow-breakpoint context with no equivalent embed query writes into a synthesized
// @media block; otherwise the embed's base, or its existing query block (or a new one).
export function createRuleForWrite(
  region: EmbedRegion,
  where: {
    nested: NestStep[] | undefined;
    bpMedia: string | undefined;
    embedContext: string | undefined;
    /** The selector the chosen context's query is nested inside, if it is. */
    wrapper: string | undefined;
    selector: string;
    write: PropWrite;
  },
): boolean {
  const { nested, bpMedia, embedContext, selector, wrapper } = where;
  const { prop, value, important } = where.write;
  if (nested) {
    return createNestedRule(region, nested, prop, { value, important });
  }
  // A nested context writes into ITS block, never the first block that spells
  // the same query (model/queryWrapper.ts).
  if (wrapper !== undefined && embedContext) {
    return createRuleInPlacedQuery(region, { atContextKey: embedContext, wrapper, selector }, prop, { value, important });
  }
  if (bpMedia) {
    return createRuleInMedia(region, bpMedia, selector, prop, { value, important });
  }
  if (!embedContext) {
    return createRuleAtRoot(region, selector, prop, { value, important });
  }
  const block = listAtRuleBlocks(region).find((entry) => entry.atContext.join(' › ') === embedContext && entry.placement.kind === 'top-level');
  return block
    ? createRuleInAtRule(block.node, selector, prop, { value, important })
    : createRuleInQuery(region, embedContext, selector, prop, { value, important });
}

// A rule's own declarations of `prop`, looked up in the live postcss AST.
export function declsFor(rule: ParsedRule, prop: string): Declaration[] {
  const key = prop.toLowerCase();
  return directDecls(rule.node).filter((declaration) => declaration.prop.trim().toLowerCase() === key);
}

// The last of them — the one that applies.
export function lastDeclFor(rule: ParsedRule, prop: string): Declaration | undefined {
  const matches = declsFor(rule, prop);
  return matches[matches.length - 1];
}

// The scan state with no element selected: the embeds' counts through an empty model.
export function unselectedScanState(content: Content, rememberedPageEmbedCount: number): ScanState {
  return {
    rootSnapshot: undefined,
    model: EMPTY_RULE_MODEL,
    placeholders: [],
    embedCount: content.embedCount,
    componentEmbedCount: content.componentEmbedCount,
    rememberedPageEmbedCount: content.scan.inComponentContext ? rememberedPageEmbedCount : 0,
    errors: content.errors,
    inComponentContext: content.scan.inComponentContext,
    // No element, so no selectors on their way: nothing to hold for.
    settled: true,
  };
}

// The scan state for a resolved element: its snapshot and model, the query scaffolds
// (inside a component only), and the scan's counts.
export function scanStateFor(
  content: Content,
  resolvedElement: { rootSnapshot: ElementSnapshot; model: RuleModel; settled: boolean },
  rememberedPageEmbedCount: number,
): ScanState {
  const { rootSnapshot, model, settled } = resolvedElement;
  return {
    rootSnapshot,
    model,
    placeholders: content.scan.inComponentContext ? computePlaceholders(content.docs, rootSnapshot.classList) : [],
    embedCount: content.embedCount,
    componentEmbedCount: content.componentEmbedCount,
    rememberedPageEmbedCount: content.scan.inComponentContext ? rememberedPageEmbedCount : 0,
    errors: content.errors,
    inComponentContext: content.scan.inComponentContext,
    settled,
  };
}

// The status line after a resolve: the matching-rule count, so far while component
// embeds are still loading.
export function resolveStatus(content: Content, model: RuleModel): string {
  const count = model.matchedRuleCount;
  if (content.partial) {
    return count > 0 ? `${count} matching rule${count === 1 ? '' : 's'} so far — scanning components…` : 'Scanning component embeds…';
  }
  if (count > 0) {
    return `${count} matching rule${count === 1 ? '' : 's'}.`;
  }
  return content.embedCount ? 'No embed styles target this element.' : 'No HTML embeds with <style> blocks found.';
}

// ─────────────────────────── Main component ───────────────────────────

// One native write attempt: whether it applied (and, creating a class, whether the class
// was new), and why not.
export type NativeAttempt = { applied: boolean; created?: boolean; reason: string };
export type EmbedWriteResult = Awaited<ReturnType<typeof writeEmbedDocument>>;
export type NestedInput = NonNullable<ReturnType<typeof parseNestedInput>>;

/**
 * The nesting paths of selectors typed with braces (`.faq_summary{&::before}`),
 * so the first edit of each writes NESTED source into the parent's rule rather
 * than a flat `.faq_summary::before`. Kept by selector and query context, and
 * taken when that selector's rule is created: re-picking a selector (the panel
 * re-picks on its own as the canvas reports matches) no longer loses the path,
 * which a single slot cleared on every pick did.
 */
export type TypedPaths = Map<string, NestedInput['path']>;

// A panel holds a handful of typed selectors at once; past this the oldest goes.
const TYPED_PATHS_MAX = 32;

function typedPathKey(selector: string, context: string): string {
  return `${selector.trim()}\u0000${context}`;
}

export function rememberTypedPath(paths: TypedPaths, selector: string, context: string, path: NestedInput['path']): void {
  assert(path.length >= 2, 'A typed path nests at least one level');
  const key = typedPathKey(selector, context);
  paths.delete(key);
  paths.set(key, path);
  while (paths.size > TYPED_PATHS_MAX) {
    const oldest = paths.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    paths.delete(oldest);
  }
  assert(paths.size <= TYPED_PATHS_MAX, 'Typed paths are bounded');
}

/** The typed path for this selector in this context, removed: its rule is being created. */
export function takeTypedPath(paths: TypedPaths, selector: string, context: string): NestedInput['path'] | undefined {
  const key = typedPathKey(selector, context);
  const path = paths.get(key);
  paths.delete(key);
  return path;
}

/** The text each nested selector was typed as, by the selector it resolves to. */
export type TypedLabels = ReadonlyMap<string, string>;

/** `labels` with `typed` recorded for `selector`, the oldest going past the bound. */
export function withTypedLabel(labels: TypedLabels, selector: string, typed: string): TypedLabels {
  assert(selector.trim() !== '', 'withTypedLabel: a label belongs to a selector');
  assert(typed.trim() !== '', 'withTypedLabel: a label has text');
  const key = selectorKey(selector);
  const entries = [...labels].filter(([existing]) => existing !== key);
  const next = new Map([...entries, [key, typed.trim()] as const].slice(-TYPED_PATHS_MAX));
  assert(next.size <= TYPED_PATHS_MAX, 'withTypedLabel: labels are bounded');
  return next;
}

export type CanvasAnswer = Awaited<ReturnType<typeof askCanvasAbout>>;

// A forced rescan re-walks the component tree for embeds; otherwise the cached
// component sources are re-read.
export type RescanOptions = { readonly rescanComponents?: boolean | undefined };

export type Content = {
  scan: EmbedScan;
  docs: EmbedDocument[];
  rules: ParsedRule[];
  errors: Array<{ label: string; message: string }>;
  embedCount: number;
  componentEmbedCount: number;
  /** True for the page-only snapshot emitted before component embeds finish loading. */
  partial?: boolean;
};

/** Reuse parsed CSS when a page gesture changes only the tree. A fresh scan
 * gives new nodes their ancestry without waiting to re-read every stylesheet. */
export function contentForCurrentTree(cached: Content, current: PageScan, selected: unknown): Content | undefined {
  const selectedId = serializeElementId(selected);
  if (!current.elementByKey.has(selectedId)) {
    return undefined;
  }
  const samePage = [...cached.scan.elementByKey].some(([id, node]) => current.elementByKey.get(id) === node);
  if (!samePage || cached.scan.embeds.length !== current.pageEmbeds.length) {
    return undefined;
  }
  const sameSources = current.pageEmbeds.every((source, index) => {
    const old = cached.scan.embeds[index];
    if (old?.key !== source.key) {
      return false;
    }
    if (source.origin.kind !== 'node') {
      return true;
    }
    const id = source.origin.nodeId;
    return current.elementByKey.get(id) === cached.scan.elementByKey.get(id);
  });
  if (!sameSources) {
    return undefined;
  }
  return {
    ...cached,
    scan: {
      ...cached.scan,
      parentByKey: current.parentByKey,
      childrenByKey: current.childrenByKey,
      elementByKey: current.elementByKey,
    },
  };
}

// The last completed embed scan, kept at module scope so it survives the tool being
// closed and reopened (ToolHost unmounts EmbedEditor on close, dropping its refs).
// Without this, every reopen re-scans every embed and the custom-code selector chips
// reappear only after that scan finishes. Restored into the refs on mount so those
// chips render from cache immediately; a background refresh still runs to catch edits,
// and scanHasElement guards against a stale page/component before reuse.
export type PersistedScan = {
  content: Content;
  docs: EmbedDocument[];
  pageDocs: EmbedDocument[];
  inComponent: boolean;
  scanAt: number;
};

// The last RESOLVED view (editorSession.view) — the matched model and the
// element snapshot the selector chips are drawn from. editorSession.scan keeps
// the parsed stylesheets; this keeps what they resolved to for the selected
// element. The panel is unmounted whenever the
// right tab isn't Style — and removing a class happens in Settings, which is exactly
// that — so without this, coming back blanks the selector well until a full re-resolve
// (a canvas round trip plus a re-match of every rule) lands. Restored only while the
// same element is still selected; a background refresh reconciles it either way.
export type PersistedView = {
  /** Node id + the file it belongs to: ids are per-page, so the file has to match too. */
  hostId: string;
  filePath: string | undefined;
  elementKey: string;
  scan: ScanState;
  quick: ElementSnapshot | undefined;
};

// What the editor keeps across remounts, in one object every hook shares: an
// importing module cannot reassign an imported binding, and these are written
// from the hooks that complete a scan and resolve a view.
export const editorSession: {
  /** The last completed embed scan (see PersistedScan). */
  scan: PersistedScan | undefined;
  /** The last resolved view (see PersistedView). */
  view: PersistedView | undefined;
} = { scan: undefined, view: undefined };

export const viewKeyMatches = (view: PersistedView | undefined) => {
  const host = getHost();
  return !!view && !!host.selectedId && view.hostId === host.selectedId && view.filePath === (host.openFilePath ?? undefined);
};

// The selected node's authored classes, straight from the page model. A `class` set by
// an expression has no literal text to read, and reports none.
export function authoredClasses(): string[] {
  const host = getHost();
  const node = host.selectedId ? findNode(host.nodes, host.selectedId) : undefined;
  return propText(node, 'class').trim().split(/\s+/).filter(Boolean);
}

/**
 * Classes the page model has just lost.
 *
 * The panel's snapshot unions the authored classes with the ones the PREVIEW last
 * reported (so classes added at runtime still show), and the preview goes on
 * reporting a removed class until the dev server re-renders the page. Left alone, a
 * class you just deleted sits in the selector well for that whole round trip — and
 * a re-scan in between puts it back. Anything that drops out of the authored list is
 * hidden from that moment; it returns if the class does, and is forgotten once the
 * preview stops reporting it too.
 */
export function useRemovedClasses(): ReadonlySet<string> {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(EMPTY_CLASSES);
  const previousRef = useRef<string[]>(authoredClasses());
  const nodeRef = useRef(getHost().selectedId);
  useEffect(() => {
    const sync = () => {
      const host = getHost();
      const now = authoredClasses();
      const previous = previousRef.current;
      previousRef.current = now;
      // A different element: nothing carries over.
      if (host.selectedId !== nodeRef.current) {
        nodeRef.current = host.selectedId;
        setRemoved((old) => (old.size ? EMPTY_CLASSES : old));
        return;
      }
      setRemoved((old) => {
        const next = new Set(old);
        for (const cls of previous) {
          if (!now.includes(cls)) {
            next.add(cls);
          }
        }
        for (const cls of now) {
          next.delete(cls);
        }
        // Once the preview has caught up there is nothing left to hide.
        const rendered = host.renderedClasses || [];
        for (const cls of [...next]) {
          if (!rendered.includes(cls)) {
            next.delete(cls);
          }
        }
        if (next.size === old.size && [...next].every((name) => old.has(name))) {
          return old;
        }
        return next;
      });
    };
    sync();
    return onHostChange(sync);
  }, []);
  return removed;
}

export const EMPTY_CLASSES: ReadonlySet<string> = new Set();

// The same snapshot without the classes that have just been removed — what the
// element is now, rather than what the preview last saw.
export function withoutClasses(snapshot: ElementSnapshot | undefined, hidden: ReadonlySet<string>): ElementSnapshot | undefined {
  if (!snapshot || !hidden.size) {
    return snapshot;
  }
  const classes = snapshot.classes.filter((name) => !hidden.has(name));
  const classList = snapshot.classList.filter((name) => !hidden.has(name));
  if (classes.length === snapshot.classes.length && classList.length === snapshot.classList.length) {
    return snapshot;
  }
  return {
    ...snapshot,
    classes,
    classList,
    attributes: { ...snapshot.attributes, class: classList.join(' ') },
  };
}

// Native class styles are determined by an element's class signature, so cache the
// read NativeModel by that signature (module scope → survives reopen). A re-selected
// element serves instantly from here while a background re-read reconciles; cleared
// on any native edit, since a class change can affect every element that uses it.
export const nativeModelCache = new Map<string, NativeModel>();

/**
 * The selector a navigator ::before or ::after row picks for `node`: the
 * pseudo-element nested in the element's first class (`.faq_summary{&::after}`),
 * or in its tag when it has no class, as if typed into the selector box, so a
 * new rule is written nested in that class's own rule and an existing one is
 * picked as it is. Undefined for a node with neither.
 */
export function pseudoSelectorInput(node: HostNode | undefined, pseudo: 'before' | 'after'): string | undefined {
  const first = propText(node, 'class').trim().split(/\s+/)[0] ?? '';
  const base = /^-?[A-Za-z_][\w-]*$/.test(first)
    ? `.${first}`
    : node?.kind === 'element' && node.name !== undefined && /^[a-z][\w-]*$/i.test(node.name)
      ? node.name
      : undefined;
  if (base === undefined) {
    return undefined;
  }
  const input = `${base}{&::${pseudo}}`;
  assert(input.endsWith(`::${pseudo}}`), 'A pseudo pick names its pseudo-element');
  return input;
}

/**
 * The pseudo-element layer the navigator has picked on the selected element,
 * or undefined while the element itself is the target. A pick on another node
 * is stale (the selection moved on), so it counts as none.
 */
export function usePseudoTarget(): PseudoTarget | undefined {
  const [target, setTarget] = useState(readPseudoTarget);
  useEffect(() => onHostChange(() => setTarget(readPseudoTarget())), []);
  return target;
}

/**
 * The box the panel lists: the picked layer, the element, or every box on a host
 * with no pseudo-element rows, where a chip is the only way to reach their rules.
 */
export function usePanelLayer(): PanelLayer {
  const [layer, setLayer] = useState(readPanelLayer);
  useEffect(() => onHostChange(() => setLayer(readPanelLayer())), []);
  return layer;
}

/** usePanelLayer, for a callback that runs outside render. */
export function readPanelLayer(): PanelLayer {
  if (!getHost().pseudoRows) {
    return 'every';
  }
  return readPseudoTarget() ?? '';
}

/**
 * Whether `activeSelector` is not yet the picked layer's. A navigator row picks its
 * selector once the panel's scan is of that element, and until then the active
 * selector is still the element's: a write now would land on the element while the
 * panel shows the pseudo-element. A selector naming any pseudo-element was picked.
 */
export function pseudoPickPending(activeSelector: string): boolean {
  if (readPseudoTarget() === undefined) {
    return false;
  }
  return selectorListLayers(activeSelector).every((layer) => layer === '');
}

export function readPseudoTarget(): PseudoTarget | undefined {
  const host = getHost();
  const request = host.pseudoRequest;
  if (request === undefined) {
    return undefined;
  }
  if (request.nodeId === host.selectedId) {
    return request.pseudo === 'before' ? '::before' : '::after';
  }
  return undefined;
}

/**
 * What a navigator ::before / ::after row picks, given what the panel knows of
 * the element: the rule that already styles that pseudo-element on it (the
 * strongest one the element matches, `.divider::before` on
 * `section.stat_wrap.divider`), or, with none, the pseudo-element nested in
 * the element's first class (pseudoSelectorInput). Waits (undefined) while the
 * panel's scan is of another element: its rules say nothing about this one.
 */
export function pseudoPickFor(
  node: HostNode | undefined,
  pseudo: 'before' | 'after',
  scan: { readonly snapshot: ElementSnapshot | undefined; readonly model: RuleModel | undefined },
): { readonly kind: 'existing'; readonly selector: string } | { readonly kind: 'typed'; readonly input: string } | { readonly kind: 'wait' } | undefined {
  const { snapshot, model } = scan;
  if (snapshot === undefined || model === undefined || !snapshotIs(snapshot, node)) {
    return { kind: 'wait' };
  }
  const strongest = strongestPseudoSelector(model, `::${pseudo}`);
  if (strongest !== undefined) {
    return { kind: 'existing', selector: strongest };
  }
  const input = pseudoSelectorInput(node, pseudo);
  return input === undefined ? undefined : { kind: 'typed', input };
}

// The strongest unconditional selector that styles `wanted` (`::before`) on the
// element: the cascade files pseudo-element rules with the conditional ones
// (cascade.ts classifyHit), so both lists are searched. A rule inside an
// at-rule is left out: it styles the pseudo-element only in that query.
// A selector with no pseudo-class beats one with: `&:hover::after` and
// `:open > &::after` are variants of `&::after`, which is the row's own rule.
// Then specificity decides, then source order, as the cascade does.
function strongestPseudoSelector(model: RuleModel, wanted: string): string | undefined {
  assert(wanted.startsWith('::'), 'strongestPseudoSelector: a pseudo-element is named with ::');
  let strongest: { readonly text: string; readonly specificity: MatchedSelector['specificity']; readonly order: number; readonly variant: boolean } | undefined;
  for (const matched of [...model.base, ...model.conditional]) {
    if (matched.rule.atContext.length > 0) {
      continue;
    }
    for (const selector of matched.matchedSelectors) {
      if (normalizePseudoElement(selector.pseudoElement) !== wanted) {
        continue;
      }
      const candidate = { text: selector.text, specificity: selector.specificity, order: matched.rule.order, variant: selector.hasPseudoClass };
      if (strongest === undefined || outranks(candidate, strongest)) {
        strongest = candidate;
      }
    }
  }
  assert(strongest === undefined || strongest.text.toLowerCase().includes(wanted.slice(1)), 'strongestPseudoSelector: the pick names its pseudo-element');
  return strongest?.text;
}

// Whether `candidate` is the better pick for a pseudo-element row (strongestPseudoSelector).
function outranks(
  candidate: { readonly specificity: MatchedSelector['specificity']; readonly order: number; readonly variant: boolean },
  held: { readonly specificity: MatchedSelector['specificity']; readonly order: number; readonly variant: boolean },
): boolean {
  if (candidate.variant !== held.variant) {
    return held.variant;
  }
  const specificity = compareSpecificity(candidate.specificity, held.specificity);
  return specificity === 0 ? candidate.order >= held.order : specificity > 0;
}

// Whether a snapshot is of `node`: the same tag, and every class its source writes.
function snapshotIs(snapshot: ElementSnapshot, node: HostNode | undefined): boolean {
  if (node?.kind !== 'element' || snapshot.tag !== node.name?.toLowerCase()) {
    return false;
  }
  const written = propText(node, 'class').trim().split(/\s+/).filter(Boolean);
  return written.every((name) => snapshot.classList.includes(name) || snapshot.classes.includes(name));
}

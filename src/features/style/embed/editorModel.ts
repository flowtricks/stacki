// The style editor's model, outside React: streaming the documents a page and
// its components style, the chips a selection shows, where a write lands, the
// scan's state and signature, and the session caches that keep a scan and a
// view across remounts (EmbedEditor.tsx).

import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import { type RuleModel } from '../model/cascade';
import { snapshotTokens, tokensToSelector } from '../model/elementTokens';
import { selectorsMatch, stateForSelector, STATES, type MatchedSelector, type StyleContext } from '../model/resolved';
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
import { canonicalCompound, compareSpecificity } from '../model/selectors';
import { normalizePseudoElement } from '../model/selectorParse';
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
  /** The pseudo-element layer picked in the navigator, when one is. */
  pseudo?: PseudoTarget | undefined;
}

/** A pseudo-element the navigator shows as a layer of its own. */
export type PseudoTarget = '::before' | '::after';

/** The chips a pseudo-element layer shows: those styling it, or all with no layer picked. */
export function pseudoLayerChips(list: readonly MatchedSelector[], pseudo: PseudoTarget | undefined): MatchedSelector[] {
  if (pseudo === undefined) {
    return [...list];
  }
  const shown = list.filter((entry) => chipPseudoElement(entry.text) === pseudo);
  assert(shown.length <= list.length, 'pseudoLayerChips: a filter never adds');
  return shown;
}

// The pseudo-element a chip's selector styles, `::before` for `.a{&::before}`'s
// display `.a::before`; the empty string for one that styles the element itself.
// A grouped chip (`.a::before, .a::after`) styles both; it counts as its first.
function chipPseudoElement(text: string): string {
  const first = text.split(',')[0] ?? '';
  return normalizePseudoElement(canonicalCompound(first).pseudoElement);
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
  const list = styledSelectorsFor(model, nativeModel, currentContext).filter((entry) => {
    if (!removedClasses.size) {
      return true;
    }
    const canon = canonicalCompound(entry.text);
    return !(canon.simple && canon.tokens.some((tok) => removedClasses.has(tok)));
  });
  const pending = pendingActiveChip(list, inputs);
  if (pending) {
    list.push(pending);
  }
  // A ::before or ::after layer picked in the navigator is its own target: only
  // the selectors that style that pseudo-element are about it, so the element's
  // own (`.stat_wrap`) and the other pseudo-element's are left out.
  const shown = pseudoLayerChips(list, inputs.pseudo);
  // Order for readability: tag → base class + pseudos → applied combo chain + pseudos
  // → standalone/global classes → data attributes → complex selectors.
  return inChipOrder(shown, inputs.classList, { byOrder: true }).map((selector) =>
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
  inputs: Pick<ChipInputs, 'activeSelector' | 'selectedSelectorText' | 'tokens'>,
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
  return {
    text: activeSelector,
    specificity: [0, 0, 0],
    state: stateForSelector(activeSelector),
    simple: canon.simple,
    key: `active:${activeSelector}`,
    pending: true,
    inContext: true,
    fromComponent: false,
  };
}

// Selectors in chip display order (see selectorOrder), then by specificity; with
// `byOrder`, a selector's own source order breaks the tie before its text does.
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
  const region =
    anchor && embedDocument && anchor.embedKey === embedDocument.source.key ? embedDocument.regions[anchor.regionIndex] : embedDocument?.regions[0];
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
  };
}

// The scan state for a resolved element: its snapshot and model, the query scaffolds
// (inside a component only), and the scan's counts.
export function scanStateFor(
  content: Content,
  resolvedElement: { rootSnapshot: ElementSnapshot; model: RuleModel },
  rememberedPageEmbedCount: number,
): ScanState {
  const { rootSnapshot, model } = resolvedElement;
  return {
    rootSnapshot,
    model,
    placeholders: content.scan.inComponentContext ? computePlaceholders(content.docs, rootSnapshot.classList) : [],
    embedCount: content.embedCount,
    componentEmbedCount: content.componentEmbedCount,
    rememberedPageEmbedCount: content.scan.inComponentContext ? rememberedPageEmbedCount : 0,
    errors: content.errors,
    inComponentContext: content.scan.inComponentContext,
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

function readPseudoTarget(): PseudoTarget | undefined {
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
// Specificity decides, then source order, as the cascade does.
function strongestPseudoSelector(model: RuleModel, wanted: string): string | undefined {
  assert(wanted.startsWith('::'), 'strongestPseudoSelector: a pseudo-element is named with ::');
  let strongest: { readonly text: string; readonly specificity: MatchedSelector['specificity']; readonly order: number } | undefined;
  for (const matched of [...model.base, ...model.conditional]) {
    if (matched.rule.atContext.length > 0) {
      continue;
    }
    for (const selector of matched.matchedSelectors) {
      if (normalizePseudoElement(selector.pseudoElement) !== wanted) {
        continue;
      }
      const stronger =
        strongest === undefined ||
        compareSpecificity(selector.specificity, strongest.specificity) > 0 ||
        (compareSpecificity(selector.specificity, strongest.specificity) === 0 && matched.rule.order >= strongest.order);
      if (stronger) {
        strongest = { text: selector.text, specificity: selector.specificity, order: matched.rule.order };
      }
    }
  }
  assert(strongest === undefined || strongest.text.includes(wanted.slice(1)), 'strongestPseudoSelector: the pick names its pseudo-element');
  return strongest?.text;
}

// Whether a snapshot is of `node`: the same tag, and every class its source writes.
function snapshotIs(snapshot: ElementSnapshot, node: HostNode | undefined): boolean {
  if (node?.kind !== 'element' || snapshot.tag !== node.name?.toLowerCase()) {
    return false;
  }
  const written = propText(node, 'class').trim().split(/\s+/).filter(Boolean);
  return written.every((name) => snapshot.classList.includes(name) || snapshot.classes.includes(name));
}

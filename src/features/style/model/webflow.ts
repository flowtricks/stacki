import { styleTransport } from '../../../ipc/editorEnvironment';
// Project-backed replacement for the Webflow Designer integration.
//
// The panel above this module is unchanged from moden: it asks for "embeds"
// that contribute page-global CSS, for the selected element's identity, and
// for the element tree around it. Only the answers differ.
//
//   Webflow                          Astro project
//   ─────────────────────────────    ────────────────────────────────────────
//   HtmlEmbed containing <style>  →  a stylesheet in the project, or a
//                                    <style> block on the page / in a chunk
//   Designer element              →  a node in the page model
//   element.getStyles() classes   →  the node's class attribute
//   native (class) styles         →  none: here every style IS css text
//   Designer variables            →  CSS custom properties found in the css
//
// The EmbedSource/EmbedDoc shapes are kept exactly, so css.ts, cascade.ts,
// resolved.ts and every section component work untouched: an embed's code is
// just text with CSS regions in it, and a stylesheet is that with one region
// covering the whole file.

import { collectRules, parseRegion, renderEmbed, splitEmbed } from './css';
import { assert } from '../../../../shared/core/assert';
import { getHost, walkNodes, type HostNode } from './host';
import type { ElementSnapshot, NativeStyle, ParsedRule, StyleRegion } from './styleTypes';
import type { MatchTarget, TreeView } from './selectors';
import { hasCanvas, queryCanvas } from '../../../editor/canvasQuery';
import { variableEdit } from '../../../ipc/variableEditBridge';
import { type AnyElement, serializeElementId, nodeById, buildSnapshot } from './webflowElement';
import { type CanvasAsk, canvasIdentityOf } from './canvasAsk';
import { isGlobalRegion } from './projectResources';
export { type ProjectVariable, streamProjectVariables, getProjectFontFamilies, type ImageAsset, getImageAssets } from './projectResources';

export {
  nativeStylingAvailable,
  type NativeWriteTarget,
  readNativeStyles,
  readNativeStyleByName,
  applyNativePropertyAt,
  removeNativePropertyAt,
  applyNativeToNewBaseClass,
  liveSetNativeProperty,
} from './nativeStubs';

export { type CanvasIdentity, type CanvasAsk, askCanvasAbout, primeDomMatches } from './canvasAsk';

export { serializeElementId, webflowClassToCss, webflowApi, buildSnapshot, resolveIdentityElement, getCurrentBreakpoint } from './webflowElement';

// ───────────────────────────── Style sources ─────────────────────────────

export type EmbedSource = {
  key: string;
  label: string;
  classNames: string[];
  fromComponent: boolean;
  componentName: string | undefined;
  order: number;
  element: AnyElement;
  instance?: AnyElement;
  /** Where the CSS lives — the panel writes back through this. `astro` is a
   *  component file whose `<style is:global>` blocks are edited in place. */
  origin:
    | { kind: 'file'; path: string }
    | { kind: 'node'; nodeId: string; filePath: string | undefined }
    /** `reach: 'page'`: the page a component is open on, whose scoped blocks
     *  reach the component through their `:global()` selectors only. */
    | { kind: 'astro'; path: string; reach?: 'page' };
};

/** One source's CSS, parsed into live regions. Its code advances only through its own
 *  methods: a write records what the source now holds, and a reload replaces the
 *  regions with a fresh read. The regions' postcss roots are edited in place. */
export class EmbedDocument {
  readonly source: EmbedSource;
  #code: string;
  #segments: string[];
  #regions: StyleRegion[];

  constructor(source: EmbedSource, code: string, segments: string[], regions: StyleRegion[]) {
    // Segments interleave the regions: one before each, and one after the last.
    assert(segments.length === regions.length + 1, 'EmbedDocument: segments around regions');
    this.source = source;
    this.#code = code;
    this.#segments = segments;
    this.#regions = regions;
  }

  /** What the source held when last read or written. */
  get code(): string {
    return this.#code;
  }

  get segments(): string[] {
    return this.#segments;
  }

  get regions(): StyleRegion[] {
    return this.#regions;
  }

  /** The source now holds `code`, serialized from these regions. */
  recordWritten(code: string): void {
    this.#code = code;
  }

  /** Take on a fresh read of the same source. */
  replaceWith(fresh: EmbedDocument): void {
    assert(fresh.source.key === this.source.key, 'EmbedDocument: reload of the same source');
    this.#segments = fresh.segments;
    this.#regions = fresh.regions;
    this.#code = fresh.code;
  }
}

export type EmbedScan = {
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
  elementByKey: Map<string, HostNode>;
  embeds: EmbedSource[];
  inComponentContext: boolean;
};

export type PageScan = {
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
  elementByKey: Map<string, HostNode>;
  pageEmbeds: EmbedSource[];
  instances: AnyElement[];
  inComponentContext: boolean;
};

export function dedupeByKey(sources: EmbedSource[]): EmbedSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.key)) {
      return false;
    }
    seen.add(source.key);
    return true;
  });
}

// Webflow appended a suffix so two embeds couldn't scaffold the same class
// name. Sources here are files and nodes with distinct identities already.
export function embedSourceClassSuffix(_source?: EmbedSource): string {
  return '';
}

// Every source of CSS that reaches this page, in cascade order: stylesheets
// first (they're linked in <head>), then the page's own <style> blocks, which
// come later in the document and so win ties.
function styleSources(): EmbedSource[] {
  const host = getHost();
  const out: EmbedSource[] = [];
  let order = 0;
  const openComponentName =
    host.openFileKind === 'component'
      ? host.openFilePath
          ?.split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, '')
      : undefined;

  for (const file of host.files) {
    out.push({
      key: `file:${file.path}`,
      label: file.rel,
      classNames: [],
      fromComponent: false,
      componentName: undefined,
      order: order++,
      element: file.path,
      origin: { kind: 'file', path: file.path },
    });
  }

  // Every OTHER component's `<style is:global>`. Those rules are unhashed, so
  // they style what the page renders no matter which file the selection came
  // from — without this, styling a component instance from a page shows an
  // empty panel even though the element is clearly styled on the canvas. The
  // open file is skipped: its own <style> blocks come from the model below,
  // and reading it twice would let the two copies write over each other.
  const contextPage = host.openFileKind === 'component' && host.contextPagePath !== host.openFilePath ? host.contextPagePath : undefined;
  let contextPageListed = false;
  for (const file of host.astroFiles) {
    if (host.openFilePath && file.path === host.openFilePath) {
      continue;
    }
    const isContextPage = file.path === contextPage;
    contextPageListed ||= isContextPage;
    out.push({
      key: `astro:${file.path}`,
      label: file.name,
      classNames: [],
      fromComponent: !isContextPage,
      componentName: isContextPage ? undefined : file.name.replace(/\.astro$/i, ''),
      order: order++,
      element: file.path,
      origin: isContextPage ? { kind: 'astro', path: file.path, reach: 'page' } : { kind: 'astro', path: file.path },
    });
  }

  // The page a component is open on: its scoped `<style>` reaches the
  // component through the selectors written `:global(…)` (componentStyles.ts
  // opens them when a component is made from the page's markup), and an edit
  // to one of those rules is an edit to the page's own rule.
  if (contextPage !== undefined && !contextPageListed) {
    out.push({
      key: `astro:${contextPage}`,
      label: contextPage.split(/[\\/]/).pop() ?? contextPage,
      classNames: [],
      fromComponent: false,
      componentName: undefined,
      order: order++,
      element: contextPage,
      origin: { kind: 'astro', path: contextPage, reach: 'page' },
    });
  }

  walkNodes(host.nodes, (node) => {
    if (node.kind !== 'raw' || node.name !== 'style') {
      return;
    }
    const isGlobal = !!node.props?.['is:global'];
    // Node ids are tree paths, so the page's first <style> and a component's
    // first <style> share one. The file is part of the key and of the origin:
    // a write meant for one block must never land in the other's.
    out.push({
      key: `node:${host.openFilePath ?? ''}:${node.id}`,
      label: isGlobal ? '<style is:global>' : '<style>',
      classNames: [],
      fromComponent: host.openFileKind === 'component',
      componentName: openComponentName,
      order: order++,
      element: node.id,
      origin: { kind: 'node', nodeId: node.id, filePath: host.openFilePath },
    });
  });

  return out;
}

// Both scans return the same thing: this app has no page/component boundary
// to cross — opening a component swaps the model, and the sources are read
// from whatever is open.
export async function scanPage(): Promise<PageScan> {
  const { parentByKey, childrenByKey, elementByKey } = buildTreeMaps();
  return {
    parentByKey,
    childrenByKey,
    elementByKey,
    pageEmbeds: styleSources(),
    instances: [],
    inComponentContext: false,
  };
}

export async function scanAllComponents(onEmbeds?: (embeds: EmbedSource[]) => void | Promise<void>): Promise<EmbedSource[]> {
  const embeds = styleSources();
  if (onEmbeds) {
    await onEmbeds(embeds);
  }
  return embeds;
}

export function scanHasElement(scan: EmbedScan, selected: AnyElement): boolean {
  return scan.elementByKey.has(serializeElementId(selected));
}

const ELEMENT_KINDS = new Set(['element', 'component', 'raw']);
const OPAQUE_COUNT_KINDS = new Set(['map', 'expr', 'chunk-group', 'cond', 'branch']);

function buildTreeMaps() {
  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  const elementByKey = new Map<string, HostNode>();
  walkNodes(getHost().nodes, (node, parent) => {
    elementByKey.set(node.id, node);
    if (parent) {
      parentByKey.set(node.id, parent.id);
      const kids = childrenByKey.get(parent.id) || [];
      kids.push(node.id);
      childrenByKey.set(parent.id, kids);
    }
  });
  return { parentByKey, childrenByKey, elementByKey };
}

function documentForSource(source: EmbedSource, code: string): EmbedDocument {
  // A component file is markup with <style> blocks in it — the shape the embed
  // model was built for. Only its global blocks are parsed; a scoped block is
  // left as untouched text, so renderEmbed writes it back verbatim and
  // rebuildRules (which skips a region without a root) never offers its rules for
  // an element in another component.
  if (source.origin.kind === 'astro') {
    const { segments, regions } = splitEmbed(code);
    const reachesPage = source.origin.reach === 'page';
    const parsed = regions.map((region) => (isGlobalRegion(region) || reachesPage ? parseRegion(region) : region));
    return new EmbedDocument(source, code, segments, parsed);
  }
  const region = parseRegion({ start: 0, end: code.length, css: code, root: undefined });
  return new EmbedDocument(source, code, ['', ''], [region]);
}

async function readSource(source: EmbedSource): Promise<string> {
  if (source.origin.kind === 'file' || source.origin.kind === 'astro') {
    const result = await variableEdit('readStyleFile', source.origin.path);
    if (!result.ok) {
      throw new Error(result.error || 'Could not read stylesheet');
    }
    return result.css ?? '';
  }
  const node = nodeById(source.origin.nodeId);
  return String(node?.inner ?? '');
}

/** The text this doc's source file should now hold. A stylesheet or a <style>
 *  node is all CSS; a component file is its markup with only the edited
 *  regions re-stringified. */
function serializeDocument(embedDocument: EmbedDocument): string {
  if (embedDocument.source.origin.kind === 'astro') {
    return renderEmbed(embedDocument.segments, embedDocument.regions);
  }
  return embedDocument.regions[0]?.root?.toString() ?? embedDocument.regions[0]?.css ?? '';
}

/**
 * Read each source's code and parse it into live regions. The reads run
 * concurrently — each is an IPC round trip to the main process, and waiting
 * for one before starting the next made the scan linear in the number of
 * stylesheets and global-style components the project has. `onDoc` fires as
 * each lands so callers can stream; the returned arrays stay in source order,
 * which is cascade order.
 */
export async function loadEmbedDocs(
  sources: EmbedSource[],
  onDocument?: (doc: EmbedDocument) => void,
): Promise<{ docs: EmbedDocument[]; errors: Array<{ label: string; message: string }> }> {
  const loaded = await Promise.all(
    sources.map(async (source) => {
      try {
        const embedDocument = documentForSource(source, await readSource(source));
        onDocument?.(embedDocument);
        return { doc: embedDocument, error: undefined };
      } catch (error: unknown) {
        return {
          doc: undefined,
          error: {
            label: source.label,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  const docs: EmbedDocument[] = [];
  const errors: Array<{ label: string; message: string }> = [];
  for (const entry of loaded) {
    if (entry.doc) {
      docs.push(entry.doc);
    }
    if (entry.error) {
      errors.push(entry.error);
    }
  }
  return { docs, errors };
}

// Counts the panel's writes. A stylesheet read that started before a write can
// finish after it, holding the file as it was: whoever stores a read compares
// this before and after, and reads again rather than putting the old CSS back.
let embedWriteCount = 0;

/** How many writes the panel has started — compare across a read to know
 *  whether one landed while it was in flight. */
export function embedWritesStarted(): number {
  return embedWriteCount;
}

export async function writeEmbedDocument(
  embedDocument: EmbedDocument,
  /** A live (scrubbing / mid-typing) write — for a <style> node it coalesces with the
   *  ones around it instead of saving the page per tick. A committed edit saves at once,
   *  so the canvas doesn't wait out a typing debounce for a single click. */
  live = false,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  embedWriteCount += 1;
  const code = serializeDocument(embedDocument);
  // What the file held before this write — the undo target, captured before
  // doc.code is advanced below.
  const before = embedDocument.code;
  try {
    if (embedDocument.source.origin.kind === 'file' || embedDocument.source.origin.kind === 'astro') {
      const { path } = embedDocument.source.origin;
      await styleTransport.writeStyleFile({ filePath: path, css: code, base: before });
      // A <style> node's write goes through the page model, which the app
      // already snapshots — only stylesheets need their own history entry.
      if (before !== code) {
        getHost().recordUndo?.({
          label: `styles in ${embedDocument.source.label}`,
          // One step per file per burst: a slider drag writes on every tick.
          coalesceKey: `css:${path}`,
          undo: () => writeStyleFileAndReload(embedDocument, path, before),
          redo: () => writeStyleFileAndReload(embedDocument, path, code),
        });
      }
    } else {
      const write = getHost().writeStyleNode;
      if (!write) {
        return { ok: false, error: 'No page open to write into.' };
      }
      // A <style> block belonging to the page, while a component is open: there
      // is no such node in the model being edited. The write used to find
      // nothing and quietly do nothing, leaving the panel to report a save the
      // canvas would never show.
      const { nodeId, filePath } = embedDocument.source.origin;
      if (write({ nodeId, filePath }, code, !live) === false) {
        return { ok: false, error: "Couldn't find that <style> block in the open file." };
      }
    }
    embedDocument.recordWritten(code);
    return { ok: true, code };
  } catch (error: unknown) {
    // An empty message says nothing, so it falls back to the thrown value itself.
    const message = error instanceof Error ? error.message : '';
    return { ok: false, error: message || String(error) };
  }
}

// Undo/redo rewrites a stylesheet behind the panel's back, so the doc it will
// write from next has to be brought back in step — otherwise the next edit
// would serialize the stale AST and quietly resurrect what was just undone.
const docsReloaded = new Set<() => void>();
export function onDocsReloaded(listener: () => void): () => void {
  docsReloaded.add(listener);
  return () => {
    docsReloaded.delete(listener);
  };
}

async function writeStyleFileAndReload(embedDocument: EmbedDocument, path: string, text: string): Promise<void> {
  embedWriteCount += 1;
  await styleTransport.writeStyleFile({ filePath: path, css: text, base: embedDocument.code });
  // Re-derive the doc from what the file now holds, the same way it was first
  // read — for a component file that means re-splitting its markup, not
  // treating the whole file as one region of CSS.
  embedDocument.replaceWith(documentForSource(embedDocument.source, text));
  for (const listener of docsReloaded) {
    listener();
  }
}

export function rebuildRules(docs: EmbedDocument[]): ParsedRule[] {
  const rules: ParsedRule[] = [];
  // One running counter across every source, so document order — and with it
  // the cascade — is comparable between a stylesheet and a <style> block.
  const order = { n: 0 };
  const ordered = [...docs].sort((left, right) => left.source.order - right.source.order);

  for (const embedDocument of ordered) {
    const origin = embedDocument.source.origin;
    const reachesPage = origin.kind === 'astro' && origin.reach === 'page';
    embedDocument.regions.forEach((region, regionIndex) => {
      if (!region.root) {
        return;
      }
      const collected = collectRules(region, {
        embedKey: embedDocument.source.key,
        embedLabel: embedDocument.source.label,
        fromComponent: embedDocument.source.fromComponent,
        componentName: embedDocument.source.componentName,
        regionIndex,
        idSeed: embedDocument.source.key,
        order,
      });
      // A scoped block of the page reaches the open component only through
      // its `:global()` selectors; its other rules style the page alone.
      const scopedToPage = reachesPage && !isGlobalRegion(region);
      rules.push(...(scopedToPage ? collected.filter(reachesComponent) : collected));
    });
  }
  return rules;
}

function reachesComponent(rule: ParsedRule): boolean {
  return rule.selectors.some((selector) => selector.text.includes(':global('));
}

// Selecting the <style> node a rule lives in; a stylesheet isn't in the tree,
// so there is nothing to navigate to.
export async function navigateToEmbed(source: EmbedSource, _pageInstances?: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (source.origin.kind === 'astro') {
    return {
      ok: false,
      error: `These styles live in ${source.label} — open that ${source.origin.reach === 'page' ? 'page' : 'component'} to see them in the tree.`,
    };
  }
  if (source.origin.kind !== 'node') {
    return { ok: false, error: `${source.label} is a stylesheet — open it from the Assets panel.` };
  }
  const select = getHost().selectNode;
  if (!select) {
    return { ok: false, error: 'Nothing to select.' };
  }
  select(source.origin.nodeId);
  return { ok: true };
}

// ───────────────────────────── Match target ─────────────────────────────

export async function resolveTarget(
  selected: AnyElement,
  scan: EmbedScan,
  /** An answer already in hand (see askCanvasAbout) — including `unasked`, which
   *  means "there was nothing to ask". Omit it and this asks the page itself. */
  asked?: CanvasAsk,
): Promise<{ target: MatchTarget; rootSnapshot: ElementSnapshot }> {
  const rootKey = serializeElementId(selected);
  const snapshots = new Map<string, ElementSnapshot | undefined>();
  const view: TreeView = {
    // The whole page model is in hand, so ancestors are never unknown.
    truncated: false,
    parentKey: (key) => scan.parentByKey.get(key),
    childKeys: (key) => scan.childrenByKey.get(key) ?? [],
    elementChildKeys: (key) => {
      const kids = scan.childrenByKey.get(key) ?? [];
      const nodes = kids.map((childKey) => scan.elementByKey.get(childKey));
      // A loop or a bare expression renders any number of elements (including
      // none), so positions around one can't be pinned down — say "unknown"
      // rather than count it as a single sibling.
      if (nodes.some((node) => node && OPAQUE_COUNT_KINDS.has(node.kind))) {
        return undefined;
      }
      return kids.filter((_, i) => ELEMENT_KINDS.has(nodes[i]?.kind ?? ''));
    },
    snapshot: async (key) => {
      if (snapshots.has(key)) {
        return snapshots.get(key);
      }
      const element = scan.elementByKey.get(key);
      const snap = element ? await buildSnapshot(element) : undefined;
      snapshots.set(key, snap);
      return snap;
    },
  };
  const target: MatchTarget = { rootKey, view };
  let rootSnapshot = await buildSnapshot(selected);
  // What the selected node actually renders as. A component instance has no
  // tag or classes of its own — `<Section>` says nothing about the
  // `<section class="section">` it produces — so the header, the chips, and
  // every selector composed from them were describing the call site rather
  // than the element on the page. The canvas knows the difference.
  let identity = asked?.kind === 'asked' ? asked.answer?.identity : undefined;
  if (asked === undefined) {
    const path = getHost().pathOf?.(rootKey);
    if (path && hasCanvas()) {
      identity = canvasIdentityOf((await queryCanvas(path, []))?.identity);
    }
  }
  if (identity) {
    const attributes = { ...identity.attributes };
    delete attributes['class'];
    if (identity.classes.length) {
      attributes['class'] = identity.classes.join(' ');
    }
    rootSnapshot = {
      ...rootSnapshot,
      tag: identity.tag,
      id: identity.id ?? rootSnapshot.id,
      classes: identity.classes,
      classList: identity.classes,
      attributes,
    };
  }
  // What the header shows is also what the MATCHER should match against. The
  // view builds its snapshots from the source tree, where a component instance
  // or a layout has no tag of its own — and the matcher rejects a type selector
  // (and `:root`) it cannot verify. So `html { … }` and `:root { … }` silently
  // failed to target the very element the panel was calling `html.theme-dark`,
  // while the class and attribute selectors beside them matched. Seed the cache
  // with the resolved snapshot so the selected element is matched as rendered.
  snapshots.set(rootKey, rootSnapshot);
  return { target, rootSnapshot };
}

// ───────────────────────────── Pure helpers ─────────────────────────────

function isFlexNumber(token: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)$/.test(token);
}

export function parseFlexShorthand(value: string): Record<string, string> | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') {
    return { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' };
  }
  if (normalized === 'auto') {
    return { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': 'auto' };
  }
  if (normalized === 'initial') {
    return { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' };
  }
  if (normalized === '' || /^(inherit|unset|revert|revert-layer)$/.test(normalized)) {
    return undefined;
  }
  if (/[a-z-]+\(/i.test(normalized)) {
    return undefined;
  }
  const tokens = normalized.split(/\s+/);
  if (tokens.length > 3) {
    return undefined;
  }
  let grow: string, shrink: string, basis: string;
  if (tokens.length === 1) {
    const first = tokens[0] ?? '';
    if (isFlexNumber(first)) {
      grow = first;
      shrink = '1';
      basis = '0';
    } else {
      grow = '1';
      shrink = '1';
      basis = first;
    }
  } else if (tokens.length === 2) {
    grow = tokens[0] ?? '';
    const second = tokens[1] ?? '';
    if (isFlexNumber(second)) {
      shrink = second;
      basis = '0';
    } else {
      shrink = '1';
      basis = second;
    }
  } else {
    grow = tokens[0] ?? '';
    shrink = tokens[1] ?? '';
    basis = tokens[2] ?? '';
  }
  if (!isFlexNumber(grow) || !isFlexNumber(shrink)) {
    return undefined;
  }
  return { 'flex-grow': grow, 'flex-shrink': shrink, 'flex-basis': basis };
}

export type { NativeStyle };

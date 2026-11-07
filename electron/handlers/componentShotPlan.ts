import { parsePage } from '../parse/astroParser';
import type { ParserNode } from '../parse/astroParserTypes';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { COMPONENT_SHOT_LIMITS } from '../../shared/properties/componentShots';
import { record } from '../../shared/core/boundary';

// Which component is where on a page, from the markers the dev server writes into every page.
//
// Every node the marked copy of a file renders sits between `<!--avb-s:PATH-->` and
// `<!--avb-e:PATH-->` comments. On a page PATH is an index trail ("0.2.1"); in any other .astro
// file it is the file's project path, a bar, and the trail ("src/components/Hero.astro|0.1").
// A component call's markers wrap exactly what that instance rendered, so the call site in the
// source file tells which component a pair of anchors holds, and the nodes between them are its
// picture. Going through the call sites rather than through attributes matters for the
// sections that wrap themselves in a shared `Section` component: the DOM then carries the
// wrapper's attributes, not their own, while the page's anchors still surround them.

/** A page the run may load. */
export interface ShotPage {
  readonly route: string;
  readonly path: string;
}

// A first segment like `en` or `pt-br` names a translation. The site's own language comes first, so a
// component is photographed with the text its author wrote, not with `/en/` winning the alphabet.
const LOCALE_SEGMENT = /^\/[a-z]{2}(?:-[a-z]{2,4})?(?:\/|$)/i;

/** Home first, then pages in the site's own language, then translations. */
const pageRank = (route: string): number => {
  if (route === '/') {
    return 0;
  }
  return LOCALE_SEGMENT.test(route) ? 2 : 1;
};

/**
 * The pages in the order they are loaded: the home page first, then the rest by route, translated
 * pages last. Dynamic routes have no address without data, so they are left out, and the list stops
 * at the bound.
 */
export function orderShotPages(pages: readonly ShotPage[]): readonly ShotPage[] {
  assert(pages.length <= LIMITS.scanEntriesMax, 'Shot pages: scan bound');
  const loadable = pages.filter((page) => !/[[\]]/.test(page.route) && page.route.startsWith('/') && page.path.endsWith('.astro'));
  const ordered = [...loadable].sort((left, right) => pageRank(left.route) - pageRank(right.route) || left.route.localeCompare(right.route));
  return ordered.slice(0, COMPONENT_SHOT_LIMITS.pagesMax);
}

export interface ShotPlan {
  /** Pages with an address of their own, in load order. */
  readonly pages: readonly ShotPage[];
  /** Pages behind a dynamic route (`[slug]`), which need an address found on another page. */
  readonly dynamicPages: readonly ShotPage[];
}

export function planShotPages(pages: readonly ShotPage[]): ShotPlan {
  assert(pages.length <= LIMITS.scanEntriesMax, 'Shot pages: scan bound');
  return {
    pages: orderShotPages(pages),
    dynamicPages: pages.filter((page) => DYNAMIC_SEGMENT.test(page.route) && page.route.startsWith('/') && page.path.endsWith('.astro')),
  };
}

const DYNAMIC_SEGMENT = /\[/;
const PARAMETER = /^\[(\.\.\.)?[A-Za-z_][\w-]*\]$/;

const segmentsOf = (route: string): string[] => route.split('/').filter((segment) => segment !== '');

/**
 * Whether `route` (an address on the site) is one the dynamic route `pattern` serves: `[slug]` takes
 * exactly one segment, `[...rest]` takes any number including none, everything else must match as written.
 */
export function routeMatchesPattern(pattern: string, route: string): boolean {
  const patternSegments = segmentsOf(pattern);
  const routeSegments = segmentsOf(route);
  assert(patternSegments.length <= 64, 'Route matching: pattern bound');
  assert(routeSegments.length <= 256, 'Route matching: route bound');
  for (let at = 0; at < patternSegments.length; at++) {
    const segment = patternSegments[at];
    assert(segment !== undefined, 'Route matching: the loop reads inside the pattern');
    if (segment.startsWith('[...') && PARAMETER.test(segment)) {
      // A rest parameter takes whatever is left, and is last.
      return at === patternSegments.length - 1;
    }
    const given = routeSegments[at];
    if (given === undefined) {
      return false;
    }
    if (PARAMETER.test(segment)) {
      continue;
    }
    if (segment !== given) {
      return false;
    }
  }
  return routeSegments.length === patternSegments.length;
}

// Lower is more specific, as Astro ranks: more fixed segments first, then parameters before rest parameters.
const specificity = (pattern: string): number =>
  segmentsOf(pattern).reduce((sum, segment) => {
    if (segment.startsWith('[...') && PARAMETER.test(segment)) {
      return sum + 100;
    }
    return PARAMETER.test(segment) ? sum + 10 : sum - 1000;
  }, 0);

/**
 * The same-site addresses a page links to, without hash and query, in the order they appear. Files other
 * than `.html` (images, PDFs, feeds) are not pages and are left out.
 */
export function sameOriginPaths(hrefs: readonly string[], origin: string): readonly string[] {
  assert(hrefs.length <= COMPONENT_SHOT_LIMITS.linksMax, 'Links: bound');
  const base = new URL(origin).origin;
  const found = new Set<string>();
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.origin !== base) {
      continue;
    }
    const segments = segmentsOf(url.pathname);
    const last = segments.at(-1);
    if (last !== undefined && last.includes('.') && !last.endsWith('.html')) {
      continue;
    }
    found.add(segments.length === 0 ? '/' : '/' + segments.join('/'));
  }
  return [...found];
}

/**
 * For each dynamic page file at most one address: the first link, in the order given, that the file's
 * route serves best. Addresses that belong to a fixed page are not dynamic. Translations come last, and
 * no more than `budget` pages are returned.
 */
export function pickDynamicPages(
  dynamicPages: readonly ShotPage[],
  links: readonly string[],
  fixedRoutes: ReadonlySet<string>,
  budget: number,
): readonly ShotPage[] {
  assert(budget >= 0, 'Dynamic pages: the budget is not negative');
  const chosen = new Map<string, ShotPage>();
  for (const link of links) {
    if (chosen.size >= dynamicPages.length || fixedRoutes.has(link)) {
      continue;
    }
    const candidates = dynamicPages
      .filter((page) => routeMatchesPattern(page.route, link))
      .sort((left, right) => specificity(left.route) - specificity(right.route) || left.path.localeCompare(right.path));
    const best = candidates[0];
    if (best !== undefined && !chosen.has(best.path)) {
      chosen.set(best.path, { route: link, path: best.path });
    }
  }
  return [...chosen.values()].sort((left, right) => pageRank(left.route) - pageRank(right.route) || left.route.localeCompare(right.route)).slice(0, budget);
}

/** The components a file calls, by the trail of the call: "0.2.1" → the file `Hero` is imported from. */
export type CallSites = ReadonlyMap<string, string>;

/**
 * Every component call in a file whose import resolves, keyed by its trail. `resolve` turns an import
 * specifier into a file; it is a parameter so the walk stays free of the file system.
 */
export function callSitesOf(source: string, resolve: (specifier: string) => string | undefined): CallSites {
  const sites = new Map<string, string>();
  const parsed = parsePage(source);
  if (!parsed.editable) {
    return sites;
  }
  const targets = new Map<string, string>();
  for (const imported of parsed.model.imports) {
    if (!targets.has(imported.name)) {
      const file = resolve(imported.path);
      if (file !== undefined) {
        targets.set(imported.name, file);
      }
    }
  }
  const pending: Array<{ readonly node: ParserNode; readonly trail: string }> = parsed.model.nodes.map((node, index) => ({ node, trail: String(index) }));
  for (let at = 0; at < pending.length && at < LIMITS.treeNodesMax; at++) {
    const entry = pending[at];
    assert(entry !== undefined, 'Call sites: the queue holds what the loop reads');
    const { node, trail } = entry;
    if (node.kind === 'component') {
      const target = targets.get(node.name);
      if (target !== undefined) {
        sites.set(trail, target);
      }
    }
    if (
      node.kind !== 'text' &&
      node.kind !== 'expr' &&
      node.kind !== 'raw-line' &&
      node.kind !== 'comment' &&
      node.kind !== 'raw' &&
      node.children !== undefined
    ) {
      node.children.forEach((child, index) => {
        pending.push({ node: child, trail: `${trail}.${index}` });
      });
    }
  }
  return sites;
}

/** Where an anchor path lives: the file whose source it indexes, and the trail inside it. */
export function splitAnchorPath(anchor: string, pageFile: string): { readonly file: string; readonly trail: string } {
  const bar = anchor.indexOf('|');
  if (bar < 0) {
    return { file: pageFile, trail: anchor };
  }
  return { file: anchor.slice(0, bar), trail: anchor.slice(bar + 1) };
}

/** A region of a rendered page, in document coordinates. */
export interface AnchorRegion {
  readonly path: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ShotAssignment {
  readonly component: string;
  readonly region: AnchorRegion;
}

/**
 * The first place each component appears on a page. `regions` are in document order, so the first region
 * that calls a component is its first instance on this page. Components already photographed on an earlier
 * page (`taken`), components the run does not want (`wanted`) and regions too thin to show are passed over.
 */
export function assignShots(
  regions: readonly AnchorRegion[],
  pageFile: string,
  taken: ReadonlySet<string>,
  callSitesFor: (file: string) => CallSites | undefined,
  wanted: (component: string) => boolean,
): readonly ShotAssignment[] {
  assert(regions.length <= COMPONENT_SHOT_LIMITS.anchorsMax, 'Shot regions: anchor bound');
  const assigned = new Map<string, ShotAssignment>();
  for (const region of regions) {
    const { file, trail } = splitAnchorPath(region.path, pageFile);
    const component = callSitesFor(file)?.get(trail);
    if (component === undefined || taken.has(component) || assigned.has(component) || !wanted(component)) {
      continue;
    }
    if (region.width < 1 || region.height < COMPONENT_SHOT_LIMITS.heightMin) {
      continue;
    }
    assigned.set(component, { component, region });
  }
  return [...assigned.values()];
}

/**
 * The walk both page scripts share: every marker pair in document order, with the box its element siblings
 * cover. Plain JavaScript in a string, because this process has no DOM types and the page needs its source
 * text; tests evaluate the same text in jsdom. `onPair` is the one statement that differs: it sees `path`,
 * `closed` and the box (`left`, `top`, `right`, `bottom`) of a pair and may push to `found`.
 */
const anchorWalkScript = (onPair: string): string => `(anchorsMax, siblingsMax) => {
  const found = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  let anchors = 0;
  for (let node = walker.nextNode(); node && anchors < anchorsMax; node = walker.nextNode()) {
    const data = node.nodeValue || '';
    if (data.indexOf('avb-s:') !== 0) continue;
    anchors += 1;
    const path = data.slice(6);
    // A loop renders its markers once per item; the first item is the one that counts.
    if (seen.has(path)) continue;
    seen.add(path);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, closed = false;
    let sibling = node.nextSibling;
    for (let steps = 0; sibling && steps < siblingsMax; steps += 1) {
      if (sibling.nodeType === 8 && sibling.nodeValue === 'avb-e:' + path) { closed = true; break; }
      if (sibling.nodeType === 1) {
        const box = sibling.getBoundingClientRect();
        if (box.width > 0 || box.height > 0) {
          left = Math.min(left, box.left + window.scrollX);
          top = Math.min(top, box.top + window.scrollY);
          right = Math.max(right, box.right + window.scrollX);
          bottom = Math.max(bottom, box.bottom + window.scrollY);
        }
      }
      sibling = sibling.nextSibling;
    }
    ${onPair}
  }
  return found;
}`;

/** The page script for the regions: each closed pair that covers room, as an AnchorRegion. */
export const COLLECT_ANCHOR_REGIONS = anchorWalkScript(
  'if (closed && right > left && bottom > top) found.push({ path, left, top, width: right - left, height: bottom - top });',
);

/** The expression that evaluates to the page's regions. */
export function collectAnchorRegionsExpression(): string {
  return `(${COLLECT_ANCHOR_REGIONS})(${COMPONENT_SHOT_LIMITS.anchorsMax}, ${COMPONENT_SHOT_LIMITS.siblingsMax})`;
}

/** What the page script answered, checked before anything is done with it. Unusable entries are an error: the script is ours. */
export function parseAnchorRegions(input: unknown): readonly AnchorRegion[] {
  if (!Array.isArray(input)) {
    throw new Error('Anchor regions: expected array');
  }
  if (input.length > COMPONENT_SHOT_LIMITS.anchorsMax) {
    throw new Error('Anchor regions: exceeds the anchor bound');
  }
  return input.map((entry: unknown): AnchorRegion => {
    const box = record(entry);
    const { path, left, top, width, height } = box;
    if (typeof path !== 'string' || path.length === 0 || path.length > LIMITS.ipcPathCharsMax) {
      throw new Error('Anchor regions: path');
    }
    if (typeof left !== 'number' || typeof top !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      throw new Error('Anchor regions: box');
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('Anchor regions: box');
    }
    if (width <= 0 || height <= 0) {
      throw new Error('Anchor regions: empty box');
    }
    return { path, left, top, width, height };
  });
}

/** The logical size to photograph a region at: its own height, within the bounds. */
export function shotHeight(region: Pick<AnchorRegion, 'height'>): number {
  assert(Number.isFinite(region.height), 'A region has a height');
  return Math.min(COMPONENT_SHOT_LIMITS.heightMax, Math.max(COMPONENT_SHOT_LIMITS.heightMin, Math.ceil(region.height)));
}

/**
 * The page script that hides everything fixed or sticky that is not inside the region at `path` — a header
 * would otherwise be photographed on top of every section — unsticks what is in the region or holds it, and returns
 * how many it hid. Names the elements with an attribute so `SHOW_FIXED` can put them back.
 */
export function hideOutsideScript(path: string): string {
  return `((path) => {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    const inside = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue !== 'avb-s:' + path) continue;
      for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === 8 && sibling.nodeValue === 'avb-e:' + path) break;
        if (sibling.nodeType === 1) inside.push(sibling);
      }
      break;
    }
    let hidden = 0;
    for (const element of document.querySelectorAll('body *')) {
      const position = getComputedStyle(element).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (inside.some((root) => element.contains(root) || root.contains(element))) {
        // Part of the region or what holds it. Left sticky it would stick below the top of the window
        // once the page scrolls there, away from where it was measured; sticky takes no room of its own,
        // so unsticking it moves nothing else.
        if (position === 'fixed') continue;
        element.setAttribute('data-shot-hidden', JSON.stringify(element.getAttribute('style')));
        element.style.setProperty('position', 'static', 'important');
        continue;
      }
      // Opacity as well as visibility: a child that sets visibility: visible shows through a hidden
      // parent (a header's menu button did, in every picture), but nothing shows through opacity 0.
      element.setAttribute('data-shot-hidden', JSON.stringify(element.getAttribute('style')));
      element.style.setProperty('visibility', 'hidden', 'important');
      element.style.setProperty('opacity', '0', 'important');
      hidden += 1;
    }
    return hidden;
  })(${JSON.stringify(path)})`;
}

export const SHOW_FIXED = `(() => {
  for (const element of document.querySelectorAll('[data-shot-hidden]')) {
    let before = null;
    try { before = JSON.parse(element.getAttribute('data-shot-hidden') || 'null'); } catch {}
    element.removeAttribute('data-shot-hidden');
    if (typeof before === 'string') element.setAttribute('style', before); else element.removeAttribute('style');
  }
  return true;
})()`;

/**
 * The page script for pairs of anchors that enclose nothing with a box: the component is on the page
 * and takes no room at this width. Same walk as the regions, so the two agree on what a pair is.
 */
export const COLLECT_EMPTY_ANCHORS = anchorWalkScript('if (closed && !(right > left && bottom > top)) found.push(path);');

export function collectEmptyAnchorsExpression(): string {
  return `(${COLLECT_EMPTY_ANCHORS})(${COMPONENT_SHOT_LIMITS.anchorsMax}, ${COMPONENT_SHOT_LIMITS.siblingsMax})`;
}

/** The page script for every link's absolute address. */
export function collectLinksExpression(): string {
  return `Array.from(document.querySelectorAll('a[href]')).slice(0, ${COMPONENT_SHOT_LIMITS.linksMax}).map((link) => link.href)`;
}

function parseStrings(input: unknown, what: string, max: number): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error(`${what}: expected array`);
  }
  if (input.length > max) {
    throw new Error(`${what}: exceeds its bound`);
  }
  const strings: string[] = [];
  for (const entry of input) {
    const value: unknown = entry;
    if (typeof value !== 'string' || value.length > LIMITS.ipcPathCharsMax) {
      throw new Error(`${what}: expected string`);
    }
    strings.push(value);
  }
  return strings;
}

export const parseAnchorPaths = (input: unknown): readonly string[] => parseStrings(input, 'Anchor paths', COMPONENT_SHOT_LIMITS.anchorsMax);
export const parseLinks = (input: unknown): readonly string[] => parseStrings(input, 'Links', COMPONENT_SHOT_LIMITS.linksMax);

/**
 * The components that stand on the page but took no room at the width it was looked at, and have no
 * photograph yet: the ones worth a second look at a narrower width.
 */
export function hiddenComponents(
  emptyPaths: readonly string[],
  pageFile: string,
  taken: ReadonlySet<string>,
  callSitesFor: (file: string) => CallSites | undefined,
  wanted: (component: string) => boolean,
): ReadonlySet<string> {
  assert(emptyPaths.length <= COMPONENT_SHOT_LIMITS.anchorsMax, 'Hidden components: anchor bound');
  const hidden = new Set<string>();
  for (const anchor of emptyPaths) {
    const { file, trail } = splitAnchorPath(anchor, pageFile);
    const component = callSitesFor(file)?.get(trail);
    if (component !== undefined && !taken.has(component) && wanted(component)) {
      hidden.add(component);
    }
  }
  return hidden;
}

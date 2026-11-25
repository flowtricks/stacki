// The layers under a point of the canvas, through component instances, for a
// Stacki app (docs/apps.md, "Layers" and "Node refs"). The canvas's own hit
// test answers in one file's namespace: the open page's, so a click on a nav
// link that BaseLayout renders through Nav and NavLink names only the page's
// <Layout>. An app pinning a comment to that link needs every file's element
// on the way down, and a way to find the same copy again.
//
// The layers are found top down, the way the editor drills into components:
// the deepest node of the page's namespace under the point; inside it, the
// root of the component it renders (a one-segment path of another namespace,
// the outermost such under the point); the deepest node of that namespace
// inside the instance; and so on until no other component's root sits inside
// the last layer. Slot content is never mistaken for a component: a slotted
// node belongs to the caller's namespace, so it is the caller's deepest node,
// and no root of another namespace sits inside it.
//
// Two paths can hold exactly the same element: an instance's marker pair and
// the root its component renders, with nothing between the markers. The start
// marker that came later in the document is the inner one (frameRegions.ts
// runOrder). A path addressed by a tag rather than markers holds the element
// it is written on; at the same element it counts as holding a marker run
// there, which is how the serializer names instances whose root it cannot
// wrap.
//
// Each layer also says which copy it is inside the layer outside it, so a ref
// survives an edit that adds copies elsewhere on the page; `resolveChain` reads
// such a chain back to the one copy it names, as an index the canvas measures by.
import { assert } from '../../shared/core/assert';
import { PRELOAD_LIMITS, isElement, type Rect } from './frameBasics';
import { rectsForPath } from './frameMeasure';
import { PATH_ATTR, pathsOf, regions, runOrder, runsOf, taggedAncestor, taggedPlaces } from './frameRegions';

/** Bounds on what a layer query reads and answers (APP_RPC_LIMITS.nodeLayersMax and coordinatePxMax). */
export const FRAME_LAYER_LIMITS = {
  /** Layers one point answers with, and steps one chain may hold. */
  layersMax: 32,
  /** Paths under one point considered at most: a page nests no deeper in practice. */
  hitsMax: 4096,
  /** A path a chain step names (LIMITS.attrCharsMax). */
  pathCharsMax: 4096,
  /** A copy a chain step names. */
  copyMax: 100_000,
} as const;

/** One layer under a point: its marked path, which copy on the page, and which copy inside the layer outside it. */
export interface FrameLayer {
  readonly path: string;
  readonly occurrence: number;
  readonly copy: number;
}

/** One step of a chain to read back, outermost first. */
export interface FrameChainStep {
  readonly path: string;
  readonly copy: number;
}

/** The copy a chain names, as the canvas measures it. */
export interface FrameChainHit {
  readonly path: string;
  readonly occurrence: number;
  readonly box: Rect | undefined;
}

// A path that holds the target: the node of its copy that does, every node of
// that copy, the marker order of the copy (undefined for a tag), and which copy.
interface Hit {
  readonly path: string;
  readonly anchor: Element;
  readonly nodes: readonly Node[];
  readonly order: number | undefined;
  readonly occurrence: number;
}

/** The layers under a viewport point, innermost first; empty over nothing marked. */
export function layersAtPoint(x: number, y: number): readonly FrameLayer[] {
  if (typeof document === 'undefined') {
    return []; // No page: a frame-free host answers nothing under any point.
  }
  const target = document.elementFromPoint(x, y);
  return target === null ? [] : layersAt(target);
}

/** The layers holding `target`, innermost first: see the module comment. */
export function layersAt(target: Element): readonly FrameLayer[] {
  const hits = hitsAt(target);
  const chosen: Hit[] = [];
  const used = new Set<string>();
  let space: string | undefined = hits.some((hit) => namespaceOf(hit.path) === '') ? '' : outermost(hits.filter((hit) => segmentsOf(hit.path) === 1));
  let outer: Hit | undefined = undefined;
  for (let step = 0; space !== undefined && step < FRAME_LAYER_LIMITS.layersMax; step += 1) {
    const inSpace = space;
    const pick = deepest(hits.filter((hit) => namespaceOf(hit.path) === inSpace && (outer === undefined || inside(hit, outer))));
    if (pick === undefined) {
      break;
    }
    chosen.push(pick);
    used.add(inSpace);
    const roots = hits.filter((hit) => !used.has(namespaceOf(hit.path)) && segmentsOf(hit.path) === 1 && inside(hit, pick));
    space = outermost(roots);
    outer = pick;
  }
  assert(chosen.length <= FRAME_LAYER_LIMITS.layersMax, 'layersAt: the layers are bounded');
  const layers = chosen.map((hit, index) => ({ path: hit.path, occurrence: hit.occurrence, copy: copyWithin(hit, chosen[index - 1]) }));
  assert(new Set(layers.map((layer) => namespaceOf(layer.path))).size === layers.length, 'layersAt: one layer per file');
  return layers.reverse();
}

/**
 * The copy a chain names (outermost step first), or undefined when the page has
 * no such copy. A step the canvas has no marker for narrows nothing: a layout
 * whose own node is not marked still leads to what it renders.
 */
export function resolveChain(chain: readonly FrameChainStep[]): FrameChainHit | undefined {
  assert(chain.length <= FRAME_LAYER_LIMITS.layersMax, 'resolveChain: the chain is bounded');
  let outerNodes: readonly Node[] | undefined = undefined;
  let found: { readonly path: string; readonly occurrence: number } | undefined = undefined;
  for (const step of chain) {
    const copies = copiesOf(step.path);
    if (copies.length === 0) {
      found = undefined;
      continue;
    }
    const within: number[] = [];
    for (const [index, copy] of copies.entries()) {
      if (outerNodes === undefined || copyIn(copy, outerNodes)) {
        within.push(index);
      }
    }
    const index = within[step.copy];
    if (index === undefined) {
      return undefined;
    }
    outerNodes = copies[index];
    found = { path: step.path, occurrence: index };
  }
  if (found === undefined) {
    return undefined;
  }
  assert(found.path === chain.at(-1)?.path, 'resolveChain: the answer is the innermost step');
  return { ...found, box: rectsForPath(found.path)?.[found.occurrence] };
}

/** A chain a host sent, or undefined when it is not one: the frame runs project code beside it, so it is checked. */
export function parseFrameChain(input: unknown): readonly FrameChainStep[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > FRAME_LAYER_LIMITS.layersMax) {
    return undefined;
  }
  const steps: FrameChainStep[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) {
      return undefined;
    }
    const path: unknown = Reflect.get(item, 'path');
    const copy: unknown = Reflect.get(item, 'copy');
    if (typeof path !== 'string' || path.length === 0 || path.length > FRAME_LAYER_LIMITS.pathCharsMax) {
      return undefined;
    }
    if (typeof copy !== 'number' || !Number.isSafeInteger(copy) || copy < 0 || copy > FRAME_LAYER_LIMITS.copyMax) {
      return undefined;
    }
    steps.push({ path, copy });
  }
  return steps;
}

// Every path holding the target: marker runs first, then the paths only tags carry.
function hitsAt(target: Element): readonly Hit[] {
  const hits: Hit[] = [];
  for (const path of regions.keys()) {
    if (hits.length >= FRAME_LAYER_LIMITS.hitsMax) {
      break;
    }
    const runs = runsOf(path) ?? [];
    for (const [index, run] of runs.entries()) {
      const anchor = run.find((node): node is Element => isElement(node) && node.isConnected && (node === target || node.contains(target)));
      if (anchor !== undefined) {
        hits.push({ path, anchor, nodes: run, order: runOrder(run), occurrence: index });
        break;
      }
    }
  }
  const seen = new Set<string>();
  let element: Element | undefined = target.closest(`[${PATH_ATTR}]`) ?? undefined;
  for (let depth = 0; element !== undefined && depth < PRELOAD_LIMITS.domDepthMax; depth += 1) {
    const holder: Element = element;
    for (const path of pathsOf(holder)) {
      if (regions.has(path) || seen.has(path) || hits.length >= FRAME_LAYER_LIMITS.hitsMax) {
        continue;
      }
      seen.add(path);
      const places = taggedPlaces(path);
      const index = places.findIndex((place) => place.el === holder || place.el.contains(holder));
      hits.push({ path, anchor: holder, nodes: [holder], order: undefined, occurrence: Math.max(0, index) });
    }
    element = taggedAncestor(holder);
  }
  return hits;
}

// Whether `inner` sits inside `outer`: by the element each holds the target with, then marker order.
function inside(inner: Hit, outer: Hit): boolean {
  if (inner.anchor === outer.anchor) {
    if (inner.order !== undefined && outer.order !== undefined) {
      return inner.order > outer.order;
    }
    return inner.path !== outer.path; // A tag at a run's element: see the module comment.
  }
  return outer.anchor.contains(inner.anchor);
}

// The deepest of one namespace's hits: the longest path, then the innermost.
function deepest(hits: readonly Hit[]): Hit | undefined {
  let best: Hit | undefined = undefined;
  for (const hit of hits) {
    if (best === undefined) {
      best = hit;
    } else if (segmentsOf(hit.path) > segmentsOf(best.path)) {
      best = hit;
    } else if (segmentsOf(hit.path) === segmentsOf(best.path) && inside(hit, best) && !inside(best, hit)) {
      best = hit;
    }
  }
  return best;
}

// The namespace of the outermost hit: the component an instance renders, of the roots inside it.
function outermost(hits: readonly Hit[]): string | undefined {
  const outer = hits.find((hit) => !hits.some((other) => other !== hit && inside(hit, other) && !inside(other, hit)));
  return outer === undefined ? undefined : namespaceOf(outer.path);
}

// Which copy `hit` is among its path's copies inside the layer outside it.
function copyWithin(hit: Hit, outer: Hit | undefined): number {
  if (outer === undefined) {
    return hit.occurrence;
  }
  const copies = copiesOf(hit.path);
  let copy = 0;
  for (let index = 0; index < hit.occurrence && index < copies.length; index += 1) {
    const candidate = copies[index];
    if (candidate !== undefined && copyIn(candidate, outer.nodes)) {
      copy += 1;
    }
  }
  assert(copy <= hit.occurrence, 'copyWithin: a copy inside a layer counts no more than on the page');
  return copy;
}

// A path's copies in the order the canvas measures them (frameMeasure.ts rectsForPath).
function copiesOf(path: string): readonly (readonly Node[])[] {
  const runs = runsOf(path);
  if (runs !== undefined && runs.length > 0) {
    return runs;
  }
  return taggedPlaces(path).map((place) => [place.el]);
}

// Whether a copy lies in an outer copy's nodes: its first element is one of them or inside one.
function copyIn(copy: readonly Node[], outerNodes: readonly Node[]): boolean {
  const first = copy.find(isElement);
  if (first === undefined) {
    return false;
  }
  return outerNodes.some((node) => node === first || node.contains(first));
}

// `src/components/Nav.astro|0.2` is in `src/components/Nav.astro|`; a page's own `0.2` is in ''.
function namespaceOf(path: string): string {
  const bar = path.lastIndexOf('|');
  return bar === -1 ? '' : path.slice(0, bar + 1);
}

function segmentsOf(path: string): number {
  return path.slice(path.lastIndexOf('|') + 1).split('.').length;
}

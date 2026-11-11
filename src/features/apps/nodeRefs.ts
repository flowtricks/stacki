// Layers and node refs (docs/apps.md, "Layers" and "Node refs"): elements inside
// component instances, which the open page does not own, named so an app can
// measure, anchor to, scroll to and find them again.
//
// The canvas frame answers in marker paths (electron/preload/frameLayers.ts):
// `src/components/NavLink.astro|0` and which copy of it. This module turns those
// into what an app reads — each file's element, its id as `page.getTree` gives it,
// its durable key when it has one, and the instances it sits in — and reads a
// ref back the other way: each step's element found in its file by key, else by
// id; its marker path from its place in that file's tree; and the frame asked
// which copy the chain names now. A step names its copy inside the step before,
// so a ref survives an edit that adds copies anywhere else on the page, and a
// key on each step survives edits to the files themselves.
//
// Host-free: the editor's commands come in through NodeRefHost, so Desktop and
// Studio resolve alike, and tests drive it with fake trees and a fake frame.
import { assert } from '../../../shared/core/assert';
import {
  APP_RPC_LIMITS,
  nodeRefKey,
  type AppNodeLayer,
  type AppNodeRef,
  type AppNodeRefStep,
  type AppNodeView,
  type AppPageView,
  type AppRect,
} from '../../../shared/properties/appsRpc';
import type { CanvasChainStep, CanvasLayer, CanvasPointReport } from '../../ui/canvasPointQuery';
import { ownKey } from './nodeKeys';
import { elementHoverNode, type CanvasHighlight, type CanvasHighlightStyle, type DeepHoverNode } from '../../../shared/properties/deepOutline';

/** What resolving asks of the editor. */
export interface NodeRefHost {
  /** The open file and its live tree, as `page.get` answers. */
  readonly open: () => AppPageView | undefined;
  /** The page the canvas renders, relative to the project: its markup's paths carry no file. */
  readonly canvasPage: () => string | undefined;
  /** Another file's tree, as `page.getTree` reads it; undefined when it cannot be read. */
  readonly tree: (file: string) => Promise<readonly AppNodeView[] | undefined>;
  /** Asks the canvas which copy a chain names now; undefined when no canvas answers. */
  readonly locate: (chain: readonly CanvasChainStep[]) => Promise<CanvasPointReport | undefined>;
}

/** Where a ref's element is drawn: the canvas path and copy the canvas measures it by, and its box now. */
export interface NodeRefTarget {
  readonly path: string;
  readonly occurrence: number;
  readonly box: AppRect | undefined;
}

/** A ref read against the files as they are now. */
export type NodeRefSteps =
  | {
      readonly found: true;
      /** The ref with each step's current id and key. */
      readonly ref: AppNodeRef;
      /** The canvas paths, outermost first, each with its copy inside the one before. */
      readonly chain: readonly CanvasChainStep[];
      /** The open file's innermost element on the way: the element itself, or the instance it renders inside. */
      readonly openNodeId: string | undefined;
      /** The element the ref names, as its file's tree has it now. */
      readonly inner: AppNodeView;
    }
  | { readonly found: false; readonly reason: string };

/** The layers of a canvas point, innermost first, from the frame's: a layer Stacki cannot name in its file is left out. */
export async function nodeLayers(host: NodeRefHost, frameLayers: readonly CanvasLayer[]): Promise<readonly AppNodeLayer[]> {
  assert(frameLayers.length <= APP_RPC_LIMITS.nodeLayersMax, 'nodeLayers: the frame names a bounded number of layers');
  const trees = treeReader(host);
  const steps: AppNodeRefStep[] = [];
  const layers: AppNodeLayer[] = [];
  for (const frameLayer of [...frameLayers].reverse()) {
    const place = splitCanvasPath(frameLayer.path, host.canvasPage());
    const tree = place === undefined ? undefined : await trees(place.file);
    const view = place === undefined || tree === undefined ? undefined : viewAtTrail(tree, place.trail);
    if (place === undefined || view === undefined) {
      continue;
    }
    const step: AppNodeRefStep = { file: place.file, nodeId: view.id, key: ownKey(view), copy: frameLayer.copy };
    layers.push({
      file: place.file,
      nodeId: view.id,
      key: step.key,
      component: view.kind === 'component' ? view.name : undefined,
      instancePath: [...steps],
      ref: { steps: [...steps, step] },
    });
    steps.push(step);
  }
  assert(layers.length <= frameLayers.length, 'nodeLayers: no layer is invented');
  return layers.reverse();
}

/** Each step of a ref found in its file now: by key first, else by id. */
export async function resolveNodeRefSteps(host: NodeRefHost, ref: AppNodeRef): Promise<NodeRefSteps> {
  assert(ref.steps.length > 0, 'resolveNodeRefSteps: a ref has a step');
  assert(ref.steps.length <= APP_RPC_LIMITS.nodeLayersMax, 'resolveNodeRefSteps: a ref is bounded');
  const trees = treeReader(host);
  const openPath = host.open()?.path;
  const canvasPage = host.canvasPage();
  const chain: CanvasChainStep[] = [];
  const steps: AppNodeRefStep[] = [];
  let openNodeId: string | undefined = undefined;
  let inner: AppNodeView | undefined = undefined;
  for (const step of ref.steps) {
    const tree = await trees(step.file);
    if (tree === undefined) {
      return { found: false, reason: `Stacki cannot read ${step.file}` };
    }
    const found = findView(tree, (view) => (step.key === undefined ? view.id === step.nodeId : ownKey(view) === step.key));
    if (found === undefined) {
      return { found: false, reason: `${step.file} has no element ${step.key ?? step.nodeId ?? ''} any more` };
    }
    const space = step.file === canvasPage ? '' : `${step.file}|`;
    chain.push({ path: `${space}${found.trail.join('.')}`, copy: step.copy });
    steps.push({ file: step.file, nodeId: found.view.id, key: ownKey(found.view), copy: step.copy });
    if (step.file === openPath) {
      openNodeId = found.view.id;
    }
    inner = found.view;
  }
  assert(inner !== undefined, 'resolveNodeRefSteps: a ref with a step names an element');
  assert(chain.length === ref.steps.length, 'resolveNodeRefSteps: one canvas path per step');
  return { found: true, ref: { steps }, chain, openNodeId, inner };
}

/** Where a ref's element is drawn on the canvas now, or why it is not. */
export async function resolveNodeRef(host: NodeRefHost, ref: AppNodeRef): Promise<NodeRefTarget | { readonly reason: string }> {
  const steps = await resolveNodeRefSteps(host, ref);
  if (!steps.found) {
    return { reason: steps.reason };
  }
  const report = await host.locate(steps.chain);
  if (report?.path === undefined) {
    return { reason: 'That element is not drawn on the canvas' };
  }
  assert(report.path === steps.chain.at(-1)?.path, 'resolveNodeRef: the canvas answers for the innermost step');
  const box = report.box === undefined ? undefined : { x: report.box.x, y: report.box.y, width: Math.max(0, report.box.w), height: Math.max(0, report.box.h) };
  return { path: report.path, occurrence: report.occurrence, box };
}

/** What `canvas.highlight` draws for a ref: its copy on the canvas now, labelled as the editor labels it. */
export async function resolveHighlight(
  host: NodeRefHost,
  ref: AppNodeRef,
  style: CanvasHighlightStyle,
): Promise<CanvasHighlight | { readonly reason: string }> {
  const steps = await resolveNodeRefSteps(host, ref);
  if (!steps.found) {
    return { reason: steps.reason };
  }
  const report = await host.locate(steps.chain);
  if (report?.path === undefined) {
    return { reason: 'That element is not drawn on the canvas' };
  }
  const inner = steps.inner;
  const node: DeepHoverNode =
    inner.kind === 'component' ? { kind: 'component', label: inner.name, tag: undefined } : elementHoverNode(inner.name || inner.kind, inner.classes.join(' '));
  return { path: report.path, occurrence: report.occurrence, node, style };
}

/**
 * A canvas path's file and trail: a bare path is the canvas page's, a scoped one
 * names its file. Undefined when the canvas page is unknown or the trail is not one.
 */
export function splitCanvasPath(path: string, canvasPage: string | undefined): { readonly file: string; readonly trail: readonly number[] } | undefined {
  const bar = path.lastIndexOf('|');
  const file = bar === -1 ? canvasPage : path.slice(0, bar);
  const local = path.slice(bar + 1);
  if (file === undefined || file === '' || !/^\d+(?:\.\d+)*$/.test(local)) {
    return undefined;
  }
  const trail = local.split('.').map(Number);
  assert(
    trail.every((index) => Number.isSafeInteger(index)),
    'splitCanvasPath: a trail is whole indexes',
  );
  return { file, trail };
}

/** The element at a trail of child indexes, as the canvas's marker paths index a file's tree. */
export function viewAtTrail(roots: readonly AppNodeView[], trail: readonly number[]): AppNodeView | undefined {
  assert(trail.length <= APP_RPC_LIMITS.treeDepthMax + 1, 'viewAtTrail: a trail is within the tree depth');
  let list = roots;
  let view: AppNodeView | undefined = undefined;
  for (const index of trail) {
    view = list[index];
    if (view === undefined) {
      return undefined;
    }
    list = view.children;
  }
  return view;
}

// The first element in document order that `matches`, with its trail.
function findView(
  roots: readonly AppNodeView[],
  matches: (view: AppNodeView) => boolean,
): { readonly view: AppNodeView; readonly trail: readonly number[] } | undefined {
  const stack: { readonly view: AppNodeView; readonly trail: readonly number[] }[] = roots.map((view, index) => ({ view, trail: [index] })).reverse();
  for (let visited = 0; stack.length > 0; visited += 1) {
    assert(visited < APP_RPC_LIMITS.treeNodesMax * 2, 'findView: the search is bounded by the reply bound');
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (matches(entry.view)) {
      return entry;
    }
    for (let index = entry.view.children.length - 1; index >= 0; index -= 1) {
      const child = entry.view.children[index];
      if (child !== undefined) {
        stack.push({ view: child, trail: [...entry.trail, index] });
      }
    }
  }
  return undefined;
}

// Trees for one resolution, each read once: the open file live, the rest from disk.
function treeReader(host: NodeRefHost): (file: string) => Promise<readonly AppNodeView[] | undefined> {
  const read = new Map<string, Promise<readonly AppNodeView[] | undefined>>();
  const open = host.open();
  return (file) => {
    if (open !== undefined && file === open.path) {
      return Promise.resolve(open.nodes);
    }
    const known = read.get(file);
    if (known !== undefined) {
      return known;
    }
    const reading = host.tree(file);
    read.set(file, reading);
    assert(read.size <= APP_RPC_LIMITS.nodeLayersMax, 'treeReader: one resolution reads a bounded number of files');
    return reading;
  };
}

// ---------------------------------------------------------------------------
// Overlay anchors on refs
// ---------------------------------------------------------------------------

/** Where overlay items anchored to refs are drawn, kept current as the page changes. */
export interface NodeRefTargets {
  /** The path and copy an anchored ref is drawn at, once resolved; undefined until then, or when it is not drawn. */
  readonly target: (ref: AppNodeRef) => { readonly path: string; readonly occurrence: number } | undefined;
  /** The refs the overlays anchor to now: new ones are resolved, gone ones forgotten. */
  readonly want: (refs: readonly AppNodeRef[]) => void;
  /** The page changed: resolve every wanted ref again. */
  readonly refresh: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  /** Counts up on every change, for useSyncExternalStore. */
  readonly version: () => number;
}

interface TargetEntry {
  readonly ref: AppNodeRef;
  readonly target: { readonly path: string; readonly occurrence: number } | undefined;
  /** Which resolution is current: an answer from an older one is dropped. */
  readonly round: number;
}

export function createNodeRefTargets(deps: { readonly host: () => NodeRefHost | undefined; readonly refsMax: number }): NodeRefTargets {
  const entries = new Map<string, TargetEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  let round = 0;
  const publish = (): void => {
    version += 1;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const resolve = (key: string, ref: AppNodeRef): void => {
    const host = deps.host();
    round += 1;
    const mine = round;
    entries.set(key, { ref, target: entries.get(key)?.target, round: mine });
    if (host === undefined) {
      return;
    }
    void resolveNodeRef(host, ref).then((resolved) => {
      const entry = entries.get(key);
      if (entry === undefined || entry.round !== mine) {
        return; // Forgotten, or asked again since.
      }
      const target = 'reason' in resolved ? undefined : { path: resolved.path, occurrence: resolved.occurrence };
      if (target?.path === entry.target?.path && target?.occurrence === entry.target?.occurrence) {
        return;
      }
      entries.set(key, { ...entry, target });
      publish();
    });
  };
  return {
    target: (ref) => entries.get(nodeRefKey(ref))?.target,
    want: (refs) => {
      const wanted = new Map(refs.slice(0, deps.refsMax).map((ref) => [nodeRefKey(ref), ref] as const));
      let dropped = false;
      for (const key of [...entries.keys()]) {
        if (!wanted.has(key)) {
          entries.delete(key);
          dropped = true;
        }
      }
      for (const [key, ref] of wanted) {
        if (!entries.has(key)) {
          resolve(key, ref);
        }
      }
      assert(entries.size <= deps.refsMax, 'NodeRefTargets: wanted refs are bounded');
      if (dropped) {
        publish();
      }
    },
    refresh: () => {
      for (const [key, entry] of [...entries]) {
        resolve(key, entry.ref);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

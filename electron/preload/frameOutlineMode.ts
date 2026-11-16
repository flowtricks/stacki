// The canvas frame's half of the deep outline mode (shared/properties/deepOutline.ts):
// the editor says the mode with `{ type: 'avb:outline-mode', mode }`, and while it
// is `deep` a hover that lands inside a closed component instance names what the
// editor would outline there with that component open (deepHoverAt), not the
// instance the open file owns, with the label the editor would give it.
// Only hover changes: a click, a double click and the context menu still resolve
// in the open file's scope, so an element inside a closed component is never
// selected, and nothing that acts on the selection can reach it. Desktop's preload
// (frameQueries.ts, frameTargets.ts) and Studio's preview client both use it.
import {
  OUTLINE_MODE_MESSAGE,
  componentNameOf,
  elementHoverNode,
  parseOutlineMode,
  type CanvasOutlineMode,
  type DeepHoverNode,
} from '../../shared/properties/deepOutline';
import { PRELOAD_LIMITS, isElement } from './frameBasics';
import { pathsOf, runsOf } from './frameRegions';
import { layersAt } from './frameLayers';

let mode: CanvasOutlineMode = 'normal';

/** Applies an outline mode message; false when the message is not one. */
export function receiveOutlineMode(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== OUTLINE_MODE_MESSAGE) {
    return false;
  }
  // Ours, malformed or not: anything but `deep` is the editor's own mode.
  mode = parseOutlineMode(Reflect.get(data, 'mode')) ?? 'normal';
  return true;
}

/** The mode the editor last said. */
export function outlineMode(): CanvasOutlineMode {
  return mode;
}

/**
 * A deep hover: the node inside the closed component under the pointer, and how the editor
 * labels it when that component is open for editing (shared/properties/deepOutline.ts).
 */
export interface DeepHover {
  readonly path: string;
  readonly occurrence: number;
  readonly node: DeepHoverNode;
}

/**
 * In deep mode, what the editor would outline under `target` with the closed component the
 * pointer is in open for editing: the deepest node of that component's own file inside the
 * instance (frameLayers.ts). The page's layout counts as the page, as the editor treats its
 * chrome, so a link in the layout's Nav is Nav's, not BaseLayout's. A component instance in
 * that file is labelled as an instance; an element by its first class, else its tag.
 * Undefined in normal mode, and on the open file's own markup outside any closed component.
 */
export function deepHoverAt(target: Element | undefined, path: string | undefined): DeepHover | undefined {
  if (mode !== 'deep' || target === undefined) {
    return undefined;
  }
  const outerFirst = [...layersAt(target)].reverse();
  const outermost = outerFirst[0];
  // The page's layout renders the document itself: its markup is the page's, and the closed component is inside it.
  const start = outermost !== undefined && outerFirst.length > 1 && rendersDocument(target, outermost.path) ? 1 : 0;
  const shown = outerFirst[start + 1];
  if (shown === undefined) {
    return undefined;
  }
  if (path !== undefined && namespaceOf(shown.path) === namespaceOf(path)) {
    return undefined; // The open file's own node: its hit names it already.
  }
  const rendered = outerFirst[start + 2];
  const node = rendered === undefined ? elementNode(target, shown.path) : componentNode(rendered.path);
  return node === undefined ? undefined : { path: shown.path, occurrence: shown.occurrence, node };
}

// A component instance, named for the component its rendered markup belongs to.
function componentNode(renderedPath: string): DeepHoverNode | undefined {
  const name = componentNameOf(renderedPath);
  return name === undefined ? undefined : { kind: 'component', label: name, tag: undefined };
}

// An element, labelled as the editor labels one (elementLabel): its first class, else its tag.
function elementNode(target: Element, path: string): DeepHoverNode | undefined {
  const element = elementOf(target, path);
  if (element === undefined) {
    return undefined;
  }
  return elementHoverNode(element.tagName, element.getAttribute('class') ?? '');
}

// Whether a layer's copy under the pointer is the document's root element: a page's layout.
function rendersDocument(target: Element, path: string): boolean {
  return elementOf(target, path) === target.ownerDocument.documentElement;
}

// The outermost element of a layer's copy under the pointer: the run's element that holds it, else the tagged ancestor.
function elementOf(target: Element, path: string): Element | undefined {
  for (const run of runsOf(path) ?? []) {
    const holder = run.find((node): node is Element => isElement(node) && node.isConnected && node.contains(target));
    if (holder !== undefined) {
      return holder;
    }
  }
  let element: Element | undefined = target;
  for (let depth = 0; element !== undefined && depth < PRELOAD_LIMITS.domDepthMax; depth += 1) {
    if (pathsOf(element).includes(path)) {
      return element;
    }
    element = element.parentElement ?? undefined;
  }
  return undefined;
}

function namespaceOf(path: string): string {
  const bar = path.lastIndexOf('|');
  return bar === -1 ? '' : path.slice(0, bar + 1);
}

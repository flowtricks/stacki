// The canvas's deep outline mode (docs/apps.md, "Outline modes"): while a Stacki
// app turns it on, hovering inside a closed component outlines exactly what the
// editor would with that component open for editing: an instance in the green
// component outline with its name, an element in the element outline with its
// first class or tag. The canvas frame names the node by its marker path in the
// component's file (`src/components/Nav.astro|0.2`), which the open file's tree
// knows nothing of, so it also sends the node's label (DeepHoverNode). Desktop's
// outlines (PreviewOverlays.tsx) and Studio's preview client (previewClient.ts)
// both draw from that.
import { assert } from '../core/assert';

/** The two outline modes: the editor's own, and the one that reaches inside closed components. */
export const CANVAS_OUTLINE_MODES = ['normal', 'deep'] as const;
export type CanvasOutlineMode = (typeof CANVAS_OUTLINE_MODES)[number];

/** The message that tells a canvas frame its outline mode. */
export const OUTLINE_MODE_MESSAGE = 'avb:outline-mode';

/** The longest component name a deep hover's label carries: a file name, never a page of text. */
export const DEEP_COMPONENT_CHARS_MAX = 120;

/**
 * The component a path's markup belongs to, named as the editor names an instance:
 * `src/components/NavLink.astro|0` is NavLink's. Undefined for the open page's own
 * bare paths and for anything that is not a marker path.
 */
export function componentNameOf(path: string): string | undefined {
  const bar = path.lastIndexOf('|');
  if (bar <= 0) {
    return undefined;
  }
  const name = (path.slice(0, bar).split('/').pop() ?? '').replace(/\.astro$/i, '');
  if (name === '' || !/^\d+(?:\.\d+)*$/.test(path.slice(bar + 1))) {
    return undefined;
  }
  assert(name.length > 0, 'componentNameOf: a name says something');
  return name.slice(0, DEEP_COMPONENT_CHARS_MAX);
}

/**
 * What a deep hover outlines, as the editor's outline draws a node of an open component
 * (PreviewOverlays.tsx OverlayInfo): an instance (green, ⬡, the component's name) or an
 * element (its first class as `.class`, else its tag, with the tag for its icon).
 */
export type DeepHoverNode =
  { readonly kind: 'component'; readonly label: string; readonly tag: undefined } | { readonly kind: 'element'; readonly label: string; readonly tag: string };

/** Classes the build adds, which no author wrote: never an element's name. */
const BUILD_CLASS = /^astro-/;

/** An element's deep hover label from what the page rendered, as elementLabel names it from source. */
export function elementHoverNode(tagName: string, classAttribute: string): DeepHoverNode {
  const tag = tagName.toLowerCase().slice(0, DEEP_COMPONENT_CHARS_MAX);
  const first = classAttribute.split(/\s+/).find((name) => name !== '' && !BUILD_CLASS.test(name));
  const label = first === undefined ? tag : `.${first.slice(0, DEEP_COMPONENT_CHARS_MAX)}`;
  assert(label.length > 0, 'elementHoverNode: a label says something');
  return { kind: 'element', label, tag };
}

/** A deep hover's node from a message, or undefined when it is not one: frames run project code. */
export function parseDeepHoverNode(input: unknown): DeepHoverNode | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const kind: unknown = Reflect.get(input, 'kind');
  const label: unknown = Reflect.get(input, 'label');
  const tag: unknown = Reflect.get(input, 'tag');
  if (typeof label !== 'string' || label.length === 0 || label.length > DEEP_COMPONENT_CHARS_MAX + 1) {
    return undefined;
  }
  if (kind === 'component') {
    return { kind, label, tag: undefined };
  }
  if (kind === 'element' && typeof tag === 'string' && /^[a-z][a-z0-9-]{0,119}$/.test(tag)) {
    return { kind, label, tag };
  }
  return undefined;
}

/** The message that tells a canvas frame an app's highlight (`canvas.highlight`), or that there is none. */
export const HIGHLIGHT_MESSAGE = 'avb:highlight';

/** How a highlight is drawn: as the editor draws a selected node (the default), or a hovered one. */
export const CANVAS_HIGHLIGHT_STYLES = ['selected', 'hover'] as const;
export type CanvasHighlightStyle = (typeof CANVAS_HIGHLIGHT_STYLES)[number];

/** What `canvas.highlight` draws: one copy of a node, how the editor labels it, and in which look. */
export interface CanvasHighlight {
  readonly path: string;
  readonly occurrence: number;
  readonly node: DeepHoverNode;
  readonly style: CanvasHighlightStyle;
}

/** A path a highlight names at most (LIMITS.attrCharsMax). */
const HIGHLIGHT_PATH_CHARS_MAX = 4096;

/** A highlight a message carries, or undefined for none or for what is not one: frames check what they are told. */
export function parseCanvasHighlight(input: unknown): CanvasHighlight | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const path: unknown = Reflect.get(input, 'path');
  const occurrence: unknown = Reflect.get(input, 'occurrence');
  const node = parseDeepHoverNode(Reflect.get(input, 'node'));
  if (typeof path !== 'string' || path.length === 0 || path.length > HIGHLIGHT_PATH_CHARS_MAX) {
    return undefined;
  }
  if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 100_000) {
    return undefined;
  }
  const style = CANVAS_HIGHLIGHT_STYLES.find((candidate) => candidate === Reflect.get(input, 'style')) ?? 'selected';
  return node === undefined ? undefined : { path, occurrence, node, style };
}

/** Whether a canvas path lies outside the open file: its namespace is not the open file's (`scope`, '' for a page). */
export function outsideScope(path: string, scope: string): boolean {
  if (scope === '') {
    return path.includes('|');
  }
  return !path.startsWith(scope);
}

/** An outline mode a message carries, or undefined when it is not one. */
export function parseOutlineMode(input: unknown): CanvasOutlineMode | undefined {
  return CANVAS_OUTLINE_MODES.find((mode) => mode === input);
}

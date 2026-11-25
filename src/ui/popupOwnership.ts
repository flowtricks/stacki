import { assert } from '../../shared/core/assert';
// Which popup a press belongs to.
//
// A popup that opens from inside another one — the variable picker from a field in
// the spacing editor, the colour picker from a swatch in a shadow layer — is drawn
// through a portal, so it lands at the end of <body> rather than inside the popover
// it came from. Every "did that press land outside me?" check is a `contains()`, and
// by the DOM's reckoning the answer for a portalled child is yes. So pressing the
// dot closed the editor the dot lives in, and pressing HEX closed the layer whose
// colour was being picked — each of them taking its own child down with it.
//
// A popup registers itself here with the element it was opened FROM. That is the
// missing link: the picker's anchor sits inside the popover, so a press inside the
// picker is a press inside the popover, however far apart the two are in the DOM.

interface Layer {
  readonly element: HTMLElement;
  readonly anchor: HTMLElement | undefined;
  readonly root: string;
  readonly depth: number;
}

const layers: Layer[] = [];
const POPUP_LAYERS_MAX = 64;

/**
 * Register an open popup and where it was opened from. Call in an effect and run
 * the returned cleanup when it closes.
 */
export function registerPopupLayer(
  element: HTMLElement | undefined,
  anchor: HTMLElement | undefined,
  scope: { readonly root: string; readonly depth: number },
): () => void {
  if (!element) {
    return () => {};
  }
  assert(layers.length < POPUP_LAYERS_MAX, 'Popup nesting exceeds the supported limit');
  const layer: Layer = { element, anchor, ...scope };
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) {
      layers.splice(i, 1);
    }
  };
}

/** Does `root` have a popup of its own open — one opened from inside it? */
export function hasOwnedPopup(root: HTMLElement | undefined): boolean {
  return !!root && layers.some((layer) => layer.anchor && root.contains(layer.anchor));
}

/**
 * Is `target` inside a popup that belongs to `root` — opened from within it, or from
 * within a popup that was? Walks the chain of anchors, so a picker opened from a
 * field in a popover opened from a layer row still counts as inside the layer row.
 */
export function inOwnedPopup(target: Node | undefined, root: HTMLElement | undefined): boolean {
  if (!target || !root) {
    return false;
  }
  const seen = new Set<Layer>();
  let layer = layers.find((layer) => layer.element.contains(target));
  while (layer && !seen.has(layer) && seen.size < POPUP_LAYERS_MAX) {
    seen.add(layer);
    const anchor = layer.anchor;
    if (!anchor) {
      return false;
    }
    if (root.contains(anchor)) {
      return true;
    }
    layer = layers.find((other) => other !== layer && other.element.contains(anchor));
  }
  return false;
}

// Children mount before their parents. React scope, rather than DOM order, makes
// simultaneous nested portals dismiss the child first and independent dialogs win last.
export function isTopPopupLayer(element: HTMLElement | undefined): boolean {
  const root = layers.at(-1)?.root;
  let top: Layer | undefined;
  for (const layer of layers) {
    if (layer.root === root && (!top || layer.depth >= top.depth)) {
      top = layer;
    }
  }
  return top !== undefined && top.element === element;
}

/**
 * Is the topmost popup one this popup opened (a submenu, a picker)? An outside press then belongs to
 * the whole stack: each layer that does not contain the press closes in the same gesture, so the user
 * never needs one press per level. Escape stays with the top layer alone (isTopPopupLayer).
 */
export function ownsTopPopupLayer(element: HTMLElement | undefined): boolean {
  if (!element) {
    return false;
  }
  const root = layers.at(-1)?.root;
  let top: Layer | undefined;
  for (const layer of layers) {
    if (layer.root === root && (!top || layer.depth >= top.depth)) {
      top = layer;
    }
  }
  if (top === undefined || top.element === element) {
    return false;
  }
  return inOwnedPopup(top.element, element);
}

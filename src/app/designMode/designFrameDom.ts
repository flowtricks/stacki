// Design mode (experimental, removable: docs/design-mode/REMOVE.md): reading a frame's document, in the frame's own
// pixels. The frame is same-origin and runs no script; its document is only read.
import { DESIGN_NODE_ATTRIBUTE, deepestDesignNode, designNodeMark, type DesignNodeAt } from '../../../shared/ipc/designSnapshot';

/** A box in a frame's own pixels. */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Elements walked up from a pressed one: past the HTML parser's own nesting limit. */
const DEPTH_MAX = 600;

/** The node of the open file drawn at a point of a frame: the nearest marked element's deepest node. */
export function nodeAtFramePoint(frame: Document, x: number, y: number): DesignNodeAt | undefined {
  let element: Element | undefined = frame.elementFromPoint(x, y) ?? undefined;
  for (let depth = 0; element !== undefined && depth < DEPTH_MAX; depth += 1) {
    const marks = element.getAttribute(DESIGN_NODE_ATTRIBUTE);
    const node = marks === null ? undefined : deepestDesignNode(marks);
    if (node !== undefined) {
      return node;
    }
    element = element.parentElement ?? undefined;
  }
  return undefined;
}

/** The box around every element that stands for one copy of a node, or undefined when the frame draws none. */
export function nodeBox(frame: Document, node: DesignNodeAt): FrameBox | undefined {
  const selector = `[${DESIGN_NODE_ATTRIBUTE}~="${CSS.escape(designNodeMark(node.path, node.copy))}"]`;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of frame.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
  }
  return left === Infinity ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}

// Where a press in the token field puts the caret (TokenField.tsx).
//
// The single-line field is a flex container: it centres a chip in a 26px row.
// In a flex container every run of text and every chip is its own flex item, and
// the empty space past the last item belongs to no item at all. A press there is
// resolved by the browser's flex hit test, not by line layout, and with a chip
// (contenteditable=false) beside a zero-width caret slot it lands on the near side
// of the chip, or leaves the caret where it was: a press to the right of a trailing
// chip put the caret in front of it. A plain input puts the caret at the end.
//
// So the field answers those presses itself. A press over text is still the
// browser's (it finds the character under the pointer, and a drag from there
// selects), and a press on a chip opens the picker; any other press is placed at
// the nearest gap between the field's text and chips, the way a text field does.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { isHTMLElementInDocument } from './model/dom';

/** A point in client coordinates, as a mouse event reports it. */
export interface ClientPoint {
  readonly x: number;
  readonly y: number;
}

/** One side of an item the caret can stand beside, in the field's own markup. */
export type CaretTarget =
  /** A position inside a text node: the caret goes exactly there. */
  | { readonly kind: 'text'; readonly node: Text; readonly offset: number }
  /** A side of a chip with no text node on that side to hold the caret. */
  | { readonly kind: 'chip'; readonly chip: HTMLElement; readonly side: 'before' | 'after' };

/** What a press at a point means: the browser's to place, or a gap to put the caret in. */
export type PressPlacement = { readonly kind: 'browser' } | { readonly kind: 'gap'; readonly target: CaretTarget };

// The zero-width space buildTokenHtml uses as a caret slot beside a chip. The
// serializer strips it, so a slot added here never reaches the written value.
export const CARET_SLOT = '​';

// A text run or chip in the field, with the box it is drawn in.
interface FieldItem {
  readonly kind: 'text' | 'chip';
  readonly node: Text | HTMLElement;
  readonly rect: DOMRect;
}

/**
 * Where a press at `point` in `field` should put the caret. Over a text run the
 * browser's own placement is right and is left alone; anywhere else (the field's
 * padding, the empty space past the last item, a zero-width caret slot) the caret
 * goes to the nearest edge of the nearest item on the nearest line.
 */
export function caretPlacementAt(field: HTMLElement, point: ClientPoint): PressPlacement {
  assert(Number.isFinite(point.x), 'caretPlacementAt: the press has an x');
  assert(Number.isFinite(point.y), 'caretPlacementAt: the press has a y');
  const items = fieldItems(field);
  if (items.length === 0) {
    // An empty field has one caret position, and focusing it is all a press needs.
    return { kind: 'browser' };
  }
  const lineDistance = Math.min(...items.map((item) => verticalDistance(item.rect, point.y)));
  const onLine = items.filter((item) => verticalDistance(item.rect, point.y) === lineDistance);
  assert(onLine.length > 0, 'caretPlacementAt: the nearest line holds an item');
  const overText = onLine.some((item) => item.kind === 'text' && item.rect.width > 0 && item.rect.left <= point.x && point.x <= item.rect.right);
  if (overText) {
    return { kind: 'browser' };
  }
  let best: { readonly target: CaretTarget; readonly distance: number } | undefined;
  for (const item of onLine) {
    const before = { target: edgeTarget(item, 'before'), distance: Math.abs(point.x - item.rect.left) };
    const after = { target: edgeTarget(item, 'after'), distance: Math.abs(point.x - item.rect.right) };
    // Strictly nearer only: on a tie the earlier edge in reading order stays, so
    // a press exactly between two items does not flicker between them.
    for (const candidate of [before, after]) {
      if (best === undefined || candidate.distance < best.distance) {
        best = candidate;
      }
    }
  }
  assert(best !== undefined, 'caretPlacementAt: a line with items has an edge');
  return { kind: 'gap', target: best.target };
}

/**
 * Put the caret at `target`. A chip side with no text beside it is given a
 * zero-width caret slot first: browsers will not hold a typing caret at an
 * element-level position next to a non-editable node, and what is typed there
 * has to go into a text node beside the chip.
 */
export function placeCaret(field: HTMLElement, target: CaretTarget): void {
  const position = caretPosition(target);
  assert(field.contains(position.node), 'placeCaret: the caret goes inside the field');
  const selection = field.ownerDocument.getSelection();
  if (selection === null) {
    return;
  }
  const range = field.ownerDocument.createRange();
  range.setStart(position.node, position.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  assert(selection.rangeCount === 1, 'placeCaret: the field holds one caret');
}

// The text node and offset a target stands for, adding a caret slot when a chip
// has no text on that side.
function caretPosition(target: CaretTarget): { readonly node: Text; readonly offset: number } {
  switch (target.kind) {
    case 'text':
      return { node: target.node, offset: target.offset };
    case 'chip': {
      const parent = target.chip.parentNode;
      assert(parent !== null, 'caretPosition: the chip is in the field');
      const ownerDocument = target.chip.ownerDocument;
      const slot = ownerDocument.createTextNode(CARET_SLOT);
      if (target.side === 'before') {
        parent.insertBefore(slot, target.chip);
        // After the slot, so the caret stands right against the chip.
        return { node: slot, offset: slot.length };
      }
      parent.insertBefore(slot, target.chip.nextSibling);
      return { node: slot, offset: 0 };
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

// The caret target on one side of an item. A chip side prefers the text node
// beside it, so a caret after a chip lands in the slot buildTokenHtml left there.
function edgeTarget(item: FieldItem, side: 'before' | 'after'): CaretTarget {
  if (item.kind === 'text') {
    assert(item.node.nodeType === 3, 'edgeTarget: a text item is a text node');
    const text = textNodeOf(item.node);
    return { kind: 'text', node: text, offset: side === 'before' ? 0 : text.length };
  }
  assert(isHTMLElementInDocument(item.node, item.node.ownerDocument), 'edgeTarget: a chip item is an element');
  const chip = item.node;
  const neighbour = side === 'before' ? chip.previousSibling : chip.nextSibling;
  if (neighbour !== null && neighbour.nodeType === 3) {
    const text = textNodeOf(neighbour);
    return { kind: 'text', node: text, offset: side === 'before' ? text.length : 0 };
  }
  return { kind: 'chip', chip, side };
}

// Every text run and chip in the field, in reading order, with its box. A chip
// is atomic and is never read into; text nested in the spans the field draws
// (colouring, the space between chips) is read wherever it sits, to the same
// depth bound as the field's other readers.
function fieldItems(field: HTMLElement): readonly FieldItem[] {
  const ownerDocument = field.ownerDocument;
  const items: FieldItem[] = [];
  const walk = (node: Node, depth: number): void => {
    if (depth > LIMITS.treeDepthMax) {
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      if (items.length >= LIMITS.treeNodesMax) {
        return;
      }
      if (child.nodeType === 3) {
        const text = textNodeOf(child);
        if (text.length > 0) {
          items.push({ kind: 'text', node: text, rect: textRect(text) });
        }
      } else if (isHTMLElementInDocument(child, ownerDocument) && child.dataset['chip'] !== undefined) {
        items.push({ kind: 'chip', node: child, rect: child.getBoundingClientRect() });
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(field, 0);
  // A node with no box at all (hidden, or not laid out) is no place for a caret.
  return items.filter((item) => item.rect.width > 0 || item.rect.height > 0);
}

function textRect(text: Text): DOMRect {
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  return range.getBoundingClientRect();
}

// How far `y` lies above or below a box; zero inside it.
function verticalDistance(rect: DOMRect, y: number): number {
  if (y < rect.top) {
    return rect.top - y;
  }
  if (rect.bottom < y) {
    return y - rect.bottom;
  }
  return 0;
}

// A node already known to be text, as the Text it is. Checked rather than
// asserted by type: nodes from a test realm are not this realm's Text.
function textNodeOf(node: Node): Text {
  const TextConstructor = node.ownerDocument?.defaultView?.Text;
  assert(TextConstructor !== undefined, 'textNodeOf: the node belongs to a window');
  assert(node instanceof TextConstructor, 'textNodeOf: the node is text');
  return node;
}

// Where an element dragged in the flow lands, auto-layout aware: within its own parent it trades places along
// the parent's direction (a row lays out across, a column and plain blocks down); over another container it
// drops in, unless the pointer is near a sibling's edge, which puts it beside that sibling. The answer carries the
// insertion line to draw. Pure over a laid-out DOM.
import { isTextLeaf } from './designDom';
import { DESIGN_LIMITS } from './designTypes';

export interface DropPoint {
  readonly xPx: number;
  readonly yPx: number;
}

export interface FlowDrop {
  readonly parent: Element;
  readonly before: Element | undefined;
  /** The line to draw, in frame coordinates. */
  readonly line: { readonly x1Px: number; readonly y1Px: number; readonly x2Px: number; readonly y2Px: number };
}

const CONTAINERLESS = new Set([
  'IMG',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'SVG',
  'svg',
  'CANVAS',
  'HR',
  'BR',
  'PICTURE',
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'A',
  'SPAN',
  'LABEL',
]);
/** The part of a sibling, from each end along its parent's direction, that means "beside it" rather than "into it". */
const EDGE_SHARE = 0.25;

function canHold(element: Element): boolean {
  return !CONTAINERLESS.has(element.tagName) && !isTextLeaf(element);
}

function direction(parent: Element): 'row' | 'column' {
  const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
  if (style === undefined) {
    return 'column';
  }
  if (style.display.includes('flex')) {
    return style.flexDirection.startsWith('row') ? 'row' : 'column';
  }
  if (style.display.includes('grid')) {
    return style.gridAutoFlow.startsWith('column') ? 'column' : 'row';
  }
  return 'column';
}

/** Children an insertion counts among: in the flow, shown, and not being dragged. */
function flowChildren(parent: Element, dragged: readonly Element[]): readonly Element[] {
  const view = parent.ownerDocument.defaultView;
  return [...parent.children].slice(0, DESIGN_LIMITS.elementsMax).filter((child) => {
    if (dragged.includes(child)) {
      return false;
    }
    const style = view?.getComputedStyle(child);
    return style === undefined || (style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed');
  });
}

/** Where in `parent` the pointer means: before the first child whose middle it has not passed. */
export function insertionIn(parent: Element, point: DropPoint, dragged: readonly Element[]): FlowDrop {
  const children = flowChildren(parent, dragged);
  const axis = direction(parent);
  const box = parent.getBoundingClientRect();
  let before: Element | undefined;
  for (const child of children) {
    const rect = child.getBoundingClientRect();
    // A wrapped row reads row by row: a child on a later line is passed only when the pointer is below its top.
    const passed =
      axis === 'row' ? point.yPx > rect.bottom || (point.yPx >= rect.top && point.xPx > rect.left + rect.width / 2) : point.yPx > rect.top + rect.height / 2;
    if (!passed) {
      before = child;
      break;
    }
  }
  return { parent, before, line: lineFor(parent, children, before, axis, box) };
}

function lineFor(parent: Element, children: readonly Element[], before: Element | undefined, axis: 'row' | 'column', box: DOMRect): FlowDrop['line'] {
  const last = children.at(-1);
  if (children.length === 0) {
    return { x1Px: box.left, y1Px: box.top + box.height / 2, x2Px: box.right, y2Px: box.top + box.height / 2 };
  }
  const reference = (before ?? last)?.getBoundingClientRect();
  if (reference === undefined) {
    return { x1Px: box.left, y1Px: box.top, x2Px: box.right, y2Px: box.top };
  }
  const edge = before === undefined ? 'end' : 'start';
  if (axis === 'row') {
    const x = edge === 'start' ? reference.left - 2 : reference.right + 2;
    return { x1Px: x, y1Px: reference.top, x2Px: x, y2Px: reference.bottom };
  }
  const y = edge === 'start' ? reference.top - 2 : reference.bottom + 2;
  return { x1Px: reference.left, y1Px: y, x2Px: reference.right, y2Px: y };
}

/** Where dragging `dragged` over `hit` (at `point`) drops it, or undefined over nothing that can hold it. */
export function flowDropAt(hit: Element, point: DropPoint, dragged: readonly Element[], home: Element): FlowDrop | undefined {
  // The chain from the hit up, without the dragged elements and what is inside them.
  const chain: Element[] = [];
  for (let element: Element | undefined = hit; element !== undefined && element.tagName !== 'HTML'; element = element.parentElement ?? undefined) {
    if (dragged.some((item) => item === element || item.contains(element))) {
      chain.length = 0;
      continue;
    }
    chain.push(element);
    if (chain.length > DESIGN_LIMITS.elementsMax) {
      break;
    }
  }
  const container = chain.find(canHold);
  if (container === undefined) {
    return undefined;
  }
  // Inside its own parent, near a child's edge (or over a child that holds nothing), the drag reorders there.
  const homeIndex = chain.indexOf(home);
  if (homeIndex > 0) {
    const child = chain[homeIndex - 1];
    if (child !== undefined) {
      const rect = child.getBoundingClientRect();
      const axis = direction(home);
      const along = axis === 'row' ? (point.xPx - rect.left) / Math.max(1, rect.width) : (point.yPx - rect.top) / Math.max(1, rect.height);
      if (!canHold(child) || along < EDGE_SHARE || along > 1 - EDGE_SHARE) {
        return insertionIn(home, point, dragged);
      }
    }
  }
  return insertionIn(container, point, dragged);
}

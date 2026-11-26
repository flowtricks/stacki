// Design mode (experimental, removable: docs/design-mode/REMOVE.md): an element being moved or resized in a frame.
//
// While the pointer is down the frame's own document is restyled, so the element follows at once. On release the
// change is written as the element's inline style through the editor's own write, in the frame's version of the
// page (designFrameOps.ts writeElementStyle), so ⌘Z takes it back like any style edit; the frame is then
// snapshotted again from the live canvas, which replaces the restyled document.
import { DESIGN_NODE_ATTRIBUTE, designNodeMark, type DesignNodeAt } from '../../../shared/ipc/designSnapshot';
import { nodeBox, type FrameBox } from './designFrameDom';
import { SNAP_BOXES_MAX, parseTranslate, remLength, snapMove, type Offset, type SnapGuide } from './designElementMath';

export type ElementHandle = 'move' | 'e' | 's' | 'se';

/** Elements one node draws at once; a node drawing more (a fragment of many) is not dragged. */
const ROOTS_MAX = 50;
/** A resize keeps at least this much of an element. */
const SIZE_PX_MIN = 8;
/** How near, on screen, an edge must come to snap. */
const SNAP_SCREEN_PX = 6;

interface Restyled {
  readonly element: HTMLElement;
  /** The element's own style text before the drag, put back when the drag is let go of. */
  readonly style: string | undefined;
  readonly translate: Offset;
  readonly width: number;
  readonly height: number;
  readonly inline: boolean;
}

export interface ElementGrip {
  readonly document: Document;
  readonly node: DesignNodeAt;
  readonly handle: ElementHandle;
  readonly box: FrameBox;
  readonly others: readonly FrameBox[];
  readonly parts: readonly Restyled[];
}

/** One style property and its new value. */
export type StyleChange = readonly (readonly [string, string])[];

export interface ElementPull {
  readonly guides: readonly SnapGuide[];
  /** What a release now would write; empty while nothing has changed. */
  readonly change: StyleChange;
}

function rootsOf(document: Document, node: DesignNodeAt): readonly HTMLElement[] {
  const selector = `[${DESIGN_NODE_ATTRIBUTE}~="${CSS.escape(designNodeMark(node.path, node.copy))}"]`;
  const marked = [...document.querySelectorAll(selector)].slice(0, ROOTS_MAX + 1);
  // Only the outermost: moving an element moves what it holds.
  const outer = marked.filter((element) => !marked.some((other) => other !== element && other.contains(element)));
  const view = document.defaultView;
  return view === null ? [] : outer.filter((element): element is HTMLElement => element instanceof view.HTMLElement);
}

function frameBoxOf(element: Element): FrameBox {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Takes hold of a node in a frame, or undefined when there is nothing of it that can be restyled. */
export function gripElement(document: Document, node: DesignNodeAt, handle: ElementHandle): ElementGrip | undefined {
  const view = document.defaultView;
  const roots = rootsOf(document, node);
  const box = nodeBox(document, node);
  const first = roots[0];
  if (view === null || first === undefined || box === undefined || roots.length > ROOTS_MAX) {
    return undefined;
  }
  const parts: Restyled[] = [];
  for (const element of roots) {
    const computed = view.getComputedStyle(element);
    const translate = parseTranslate(computed.translate);
    if (translate === undefined) {
      return undefined;
    }
    parts.push({
      element,
      style: element.getAttribute('style') ?? undefined,
      translate,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      inline: computed.display === 'inline',
    });
  }
  const parent = first.parentElement ?? undefined;
  const around = parent === undefined ? [] : [parent, ...Array.from(parent.children).filter((child) => !roots.some((root) => root === child))];
  const others = around
    .slice(0, SNAP_BOXES_MAX)
    .map(frameBoxOf)
    .filter((other) => other.width > 0 && other.height > 0);
  return { document, node, handle, box, others, parts };
}

/** Restyles the held element for a pointer `delta` frame pixels from where it took hold. */
export function pullElement(grip: ElementGrip, delta: Offset, zoom: number): ElementPull {
  const rootPx = Number.parseFloat(grip.document.defaultView?.getComputedStyle(grip.document.documentElement).fontSize ?? '') || 16;
  const first = grip.parts[0];
  if (first === undefined) {
    throw new Error('Assertion failed: pullElement: a grip holds an element');
  }
  // An inline box takes no translate or size, so it becomes an inline block.
  const display: StyleChange = first.inline ? [['display', 'inline-block']] : [];
  if (grip.handle === 'move') {
    const snapped = snapMove(grip.box, delta, grip.others, SNAP_SCREEN_PX / zoom);
    for (const part of grip.parts) {
      restyle(part, display);
      part.element.style.setProperty('translate', `${String(part.translate.x + snapped.offset.x)}px ${String(part.translate.y + snapped.offset.y)}px`);
    }
    const value = `${remLength(first.translate.x + snapped.offset.x, rootPx)} ${remLength(first.translate.y + snapped.offset.y, rootPx)}`;
    return { guides: snapped.guides, change: [...display, ['translate', value]] };
  }
  const width = Math.max(SIZE_PX_MIN, first.width + delta.x);
  const height = Math.max(SIZE_PX_MIN, first.height + delta.y);
  const size: (readonly [string, string])[] = [];
  if (grip.handle !== 's') {
    size.push(['width', remLength(width, rootPx)]);
  }
  if (grip.handle !== 'e') {
    size.push(['height', remLength(height, rootPx)]);
  }
  const change = [...display, ...size];
  restyle(first, change);
  return { guides: [], change };
}

function restyle(part: Restyled, change: StyleChange): void {
  for (const [property, value] of change) {
    part.element.style.setProperty(property, value);
  }
}

/** Puts the frame's document back as it was: a drag let go of, or a write refused. */
export function releaseElement(grip: ElementGrip): void {
  for (const part of grip.parts) {
    if (part.style === undefined) {
      part.element.removeAttribute('style');
    } else {
      part.element.setAttribute('style', part.style);
    }
  }
}

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
  /** While resizing: the size the element is drawn at, in the frame's pixels. */
  readonly size: { readonly width: number; readonly height: number } | undefined;
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
  // Each pull starts from the element as it was, so only what this size needs is written.
  releaseElement(grip);
  // An inline box takes no translate or size, so it becomes an inline block.
  const display: StyleChange = first.inline ? [['display', 'inline-block']] : [];
  if (grip.handle === 'move') {
    const snapped = snapMove(grip.box, delta, grip.others, SNAP_SCREEN_PX / zoom);
    for (const part of grip.parts) {
      restyle(part, display);
      part.element.style.setProperty('translate', `${String(part.translate.x + snapped.offset.x)}px ${String(part.translate.y + snapped.offset.y)}px`);
    }
    const value = `${remLength(first.translate.x + snapped.offset.x, rootPx)} ${remLength(first.translate.y + snapped.offset.y, rootPx)}`;
    return { guides: snapped.guides, change: [...display, ['translate', value]], size: undefined };
  }
  restyle(first, display);
  const change: (readonly [string, string])[] = [...display];
  if (grip.handle !== 's') {
    change.push(...sizeTo(first, 'width', Math.max(SIZE_PX_MIN, first.width + delta.x), rootPx));
  }
  if (grip.handle !== 'e') {
    change.push(...sizeTo(first, 'height', Math.max(SIZE_PX_MIN, first.height + delta.y), rootPx));
  }
  const drawn = first.element.getBoundingClientRect();
  return { guides: [], change, size: { width: Math.round(drawn.width), height: Math.round(drawn.height) } };
}

/** A rendered size this close to the one asked for is that size. */
const SIZE_SLACK_PX = 1;

/**
 * Makes the element be `wanted` pixels in one dimension, writing only what that takes. A width or height alone often
 * does nothing: a flex item grows or takes its basis instead, and a minimum or maximum overrides it. Each is set
 * aside only when it is what stands in the way. When the content itself will not go smaller, the size written is the
 * one drawn, so the handle stops there and nothing is saved that has no effect.
 */
function sizeTo(part: Restyled, dimension: 'width' | 'height', wanted: number, rootPx: number): StyleChange {
  const { element } = part;
  const view = element.ownerDocument.defaultView;
  const written = new Map<string, string>();
  const set = (property: string, value: string): void => {
    written.set(property, value);
    element.style.setProperty(property, value);
  };
  const drawn = (): number => element.getBoundingClientRect()[dimension];
  const off = (): boolean => Math.abs(drawn() - wanted) > SIZE_SLACK_PX;
  set(dimension, remLength(wanted, rootPx));
  const holder = element.parentElement;
  if (off() && view !== null && holder !== null) {
    const layout = view.getComputedStyle(holder);
    const along = layout.display.endsWith('flex') && layout.flexDirection.startsWith('column') === (dimension === 'height');
    if (along) {
      set('flex-grow', '0');
      if (off() && view.getComputedStyle(element).flexBasis !== 'auto') {
        set('flex-basis', 'auto');
      }
      if (off()) {
        set('flex-shrink', '0');
      }
    }
  }
  if (off() && drawn() > wanted) {
    set(`min-${dimension}`, '0rem');
  }
  if (off() && drawn() < wanted) {
    set(`max-${dimension}`, 'none');
  }
  if (off()) {
    set(dimension, remLength(drawn(), rootPx));
  }
  return [...written];
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

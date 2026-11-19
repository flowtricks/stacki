// The drag in flight over the canvas, as both of its pictures read it: the canvas overlay
// (src/features/preview/CanvasDropOverlay.tsx) and the Navigator (src/features/structure/StructurePanel.tsx).
//
// Why one record both subscribe to: the line on the canvas and the line in the tree are two drawings of one
// decision (src/editor/canvasDrop.ts). The drag controller (src/app/state/appCanvasDrag.ts) publishes each
// decision here once; React renders both subscribers in the same commit, so the Navigator never lags the canvas
// by a frame and the two can never show different places.
//
// One window drags one thing at a time, so a module-level slot is enough (as src/editor/dragState.ts holds the
// native drag). `undefined` means no canvas drag is under way.

import { assert } from '../../shared/core/assert';
import type { PlacementMessage } from '../../shared/page/placement';
import type { DropDecision, DropGuide, DropPoint, DropRect } from './canvasDrop';
import type { Translator } from '../../shared/properties/i18n/messageRef';

/** What is moving, for the chip that says so: an element, a component instance, a loop, text, or a new component from the palette. */
export type CanvasDragSubject =
  | { readonly kind: 'element' | 'component' | 'loop' | 'text'; readonly id: string; readonly label: string }
  | { readonly kind: 'new'; readonly label: string; readonly path?: string };

/** What the drop will do where the pointer is. */
export type CanvasDropVerdict =
  /** It moves (or inserts) the node there; `warning` is a caution the placement rule could not rule out. */
  | { readonly kind: 'valid'; readonly warning: PlacementMessage | undefined }
  /** The place cannot take it, but a neighbour can: the line shows the neighbour and the drop lands there. */
  | { readonly kind: 'snap'; readonly to: { readonly parentId: string | undefined; readonly index: number }; readonly reason: PlacementMessage }
  /** Nowhere: the drop writes nothing, and `reason` says why. */
  | { readonly kind: 'refused'; readonly reason: CanvasDropReason }
  /** The node stays where it is: dropping writes nothing, and nothing needs explaining. */
  | { readonly kind: 'noop' }
  /** Over nothing (outside the page): a release cancels. */
  | { readonly kind: 'none' };

/** Why a drop is refused: the placement rule's own message, or one of the canvas's. */
export type CanvasDropReason =
  { readonly kind: 'placement'; readonly message: PlacementMessage } | { readonly kind: 'self' } | { readonly kind: 'no-slot'; readonly name: string };

/** Whether a verdict refuses the node over itself or over something inside it: the Navigator stays silent about it. */
export function selfRefusal(verdict: CanvasDropVerdict): boolean {
  if (verdict.kind !== 'refused') {
    return false;
  }
  if (verdict.reason.kind === 'self') {
    return true;
  }
  return verdict.reason.kind === 'placement' && verdict.reason.message.reason === 'self-drop';
}

/** Where the drop lands, as the Navigator draws it: a gap between rows, or the row of an empty container. */
export type NavigatorDropMark =
  { readonly kind: 'gap'; readonly parentId: string | undefined; readonly index: number } | { readonly kind: 'into'; readonly intoId: string };

export interface CanvasDragView {
  readonly subject: CanvasDragSubject;
  readonly decision: DropDecision;
  readonly verdict: CanvasDropVerdict;
  /** The line or placeholder the canvas draws: the decision's, or the snapped neighbour's; undefined when nothing is drawn. */
  readonly guide: DropGuide | undefined;
  /** The box of the container the drop lands in, and its canvas path for the name tag (undefined for the file's root list). */
  readonly parent: { readonly box: DropRect; readonly path: string | undefined } | undefined;
  /** The Navigator's mark; undefined when the drop goes nowhere. */
  readonly navigator: NavigatorDropMark | undefined;
  /** Rows the Navigator opens for the drag, so the mark can be seen; closed again when the drag ends. */
  readonly expand: ReadonlySet<string>;
  /** The row to keep in view in the Navigator. */
  readonly revealId: string | undefined;
  /** The dragged node's boxes, dimmed on the canvas. */
  readonly dragged: readonly DropRect[];
  readonly pointer: DropPoint;
}

let current: CanvasDragView | undefined;
const listeners = new Set<() => void>();
// One subscriber per mounted picture: the canvas overlay and the Navigator, a handful at most.
const LISTENERS_MAX = 64;

export function canvasDragView(): CanvasDragView | undefined {
  return current;
}

/** Whether a drag is over the canvas: a primitive, so a subscriber that only needs this re-renders twice per drag. */
export function canvasDragActive(): boolean {
  return current !== undefined;
}

/**
 * What the Navigator reads of the drag: the same object until its mark, the rows it opens, the row to reveal, the
 * moving row or the verdict change. The canvas follows the pointer every probe; the Navigator re-renders only when
 * what it draws changes, so a large tree costs nothing while the pointer moves within one place.
 */
export type NavigatorDragView = Pick<CanvasDragView, 'subject' | 'navigator' | 'expand' | 'revealId' | 'verdict' | 'decision'>;

let navigatorSlice: NavigatorDragView | undefined;

export function navigatorDragView(): NavigatorDragView | undefined {
  return navigatorSlice;
}

function navigatorKey(view: NavigatorDragView): string {
  const mark =
    view.navigator === undefined
      ? ''
      : view.navigator.kind === 'into'
        ? `into:${view.navigator.intoId}`
        : `gap:${view.navigator.parentId ?? ''}:${view.navigator.index}`;
  const subject = view.subject.kind === 'new' ? `new:${view.subject.label}` : view.subject.id;
  const reason =
    view.verdict.kind === 'refused'
      ? JSON.stringify(view.verdict.reason)
      : view.verdict.kind === 'snap'
        ? view.verdict.reason.reason
        : view.verdict.kind === 'valid'
          ? (view.verdict.warning?.reason ?? '')
          : '';
  const loop = view.decision.kind === 'place' && view.decision.loop ? 'loop' : '';
  return [mark, [...view.expand].join(','), view.revealId ?? '', subject, view.verdict.kind, reason, loop].join('\u0000');
}

export function publishCanvasDrag(next: CanvasDragView | undefined): void {
  if (next === current) {
    return;
  }
  current = next;
  if (next === undefined) {
    navigatorSlice = undefined;
  } else if (navigatorSlice === undefined || navigatorKey(navigatorSlice) !== navigatorKey(next)) {
    navigatorSlice = {
      subject: next.subject,
      navigator: next.navigator,
      expand: next.expand,
      revealId: next.revealId,
      verdict: next.verdict,
      decision: next.decision,
    };
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * A drag over the Navigator (a row, or a component from the palette), drawn on the canvas too: the parent the
 * Navigator's mark lands in, the index, and the two siblings either side of it, which are all the canvas needs to
 * draw the line where the model would (canvasDrop.ts guideForPlace).
 */
export interface NavigatorDropShown {
  readonly parentId: string | undefined;
  readonly index: number;
  /** The siblings at index - 1 and index, when there are: the line stands between them. */
  readonly neighbours: readonly { readonly id: string; readonly index: number }[];
}

let navigatorDrop: NavigatorDropShown | undefined;

export function navigatorDropShown(): NavigatorDropShown | undefined {
  return navigatorDrop;
}

export function publishNavigatorDrop(next: NavigatorDropShown | undefined): void {
  if (next === navigatorDrop) {
    return;
  }
  if (next !== undefined && navigatorDrop !== undefined) {
    if (next.parentId === navigatorDrop.parentId && next.index === navigatorDrop.index) {
      return; // The same place: nothing to draw again.
    }
  }
  navigatorDrop = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeCanvasDrag(listener: () => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'subscribeCanvasDrag: subscribers stay inside their bound');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The words beside the pointer: why the drop goes nowhere, where it goes instead, or what it does inside a loop. */
export function dropReasonText(view: Pick<CanvasDragView, 'decision' | 'verdict'>, translate: Translator): string | undefined {
  const verdict = view.verdict;
  switch (verdict.kind) {
    case 'refused':
      switch (verdict.reason.kind) {
        case 'placement':
          return translate(verdict.reason.message.messageKey, verdict.reason.message.params);
        case 'self':
          return translate('preview.drag.self');
        case 'no-slot':
          return translate('preview.drag.noSlot', { name: verdict.reason.name });
        default: {
          const exhaustive: never = verdict.reason;
          return exhaustive;
        }
      }
    case 'snap':
      return translate('structure.placement.snapped', { reason: translate(verdict.reason.messageKey, verdict.reason.params) });
    case 'valid':
      if (verdict.warning !== undefined) {
        return translate(verdict.warning.messageKey, verdict.warning.params);
      }
      return view.decision.kind === 'place' && view.decision.loop ? translate('preview.drag.intoLoop') : undefined;
    case 'none':
      return translate('preview.drag.outside');
    case 'noop':
      return undefined;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

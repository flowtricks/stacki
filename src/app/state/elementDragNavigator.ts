// The Navigator during a drag from the Add elements panel. The Navigator is a drop target, so it must be on screen
// the moment a tile is picked up; but switching the left panel to it would take the dragged tile out of the page,
// and a drag whose source is gone never reports its end. So the Navigator is drawn over the panel for the drag
// (AppShell.tsx, ElementsTab) and taken away when the drag ends, however it ends: dropped, released over nothing,
// or abandoned with Escape. The panel underneath is never touched, so it comes back exactly as it was.
//
// A small state machine, pure so its transitions are tested without a DOM; the hook below feeds it the panel's drag
// phases and, as a safety net, the window's own `dragend` and `drop`.
import { useCallback, useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';

export type ElementDragState =
  | { readonly kind: 'idle' }
  /** `navigator` is whether the Navigator is drawn: a role without it drags onto the canvas alone. */
  | { readonly kind: 'dragging'; readonly navigator: 'overlay' | 'none' };

export type ElementDragEvent = { readonly kind: 'start'; readonly navigator: 'allowed' | 'denied' } | { readonly kind: 'end' };

export const ELEMENT_DRAG_IDLE: ElementDragState = { kind: 'idle' };

export function nextElementDragState(state: ElementDragState, event: ElementDragEvent): ElementDragState {
  switch (event.kind) {
    case 'start': {
      // A second start without an end (one drag cannot overlap another) keeps the picture as it is.
      if (state.kind === 'dragging') {
        return state;
      }
      const next: ElementDragState = { kind: 'dragging', navigator: event.navigator === 'allowed' ? 'overlay' : 'none' };
      assert(next.navigator === 'none' || event.navigator === 'allowed', 'nextElementDragState: the Navigator shows only where the role has it');
      return next;
    }
    case 'end':
      return ELEMENT_DRAG_IDLE;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Whether the Navigator is drawn over the panel now. */
export function navigatorShown(state: ElementDragState): boolean {
  return state.kind === 'dragging' && state.navigator === 'overlay';
}

/** The drag's state, and the callback the panel reports its drag phases to. */
export function useElementDragNavigator(navigator: 'allowed' | 'denied'): {
  readonly state: ElementDragState;
  readonly onDragPhase: (phase: 'start' | 'end') => void;
} {
  const [state, setState] = useState<ElementDragState>(ELEMENT_DRAG_IDLE);
  const onDragPhase = useCallback(
    (phase: 'start' | 'end'): void =>
      setState((previous) => nextElementDragState(previous, phase === 'start' ? { kind: 'start', navigator } : { kind: 'end' })),
    [navigator],
  );
  const dragging = state.kind === 'dragging';
  // The tile reports its own end; the window's events cover an end the tile missed (its drop removed it, say).
  useEffect(() => {
    if (!dragging) {
      return undefined;
    }
    const finish = (): void => setState((previous) => nextElementDragState(previous, { kind: 'end' }));
    window.addEventListener('dragend', finish);
    window.addEventListener('drop', finish);
    return () => {
      window.removeEventListener('dragend', finish);
      window.removeEventListener('drop', finish);
    };
  }, [dragging]);
  return { state, onDragPhase };
}

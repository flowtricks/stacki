import { useEffect, type RefObject } from 'react';
import { inOwnedPopup } from './popupOwnership';

// Holding the page still under a popup that is anchored to a field.
//
// A popup drawn over the field it edits (the custom-value box) must not let the
// page scroll underneath it, or the field moves away from the box describing it.
// So a wheel or touch drag anywhere else is refused. "Anywhere else" has to
// leave out the popups the box opens itself: the variable chooser is portalled
// to <body>, so by the DOM it is outside the box, and refusing its wheel left a
// list that only scrolled by dragging its scrollbar.

/** Does a wheel at `target` belong to `box`: inside it, or inside a popup opened from it? */
export function wheelBelongsTo(box: HTMLElement | undefined, target: EventTarget | undefined): boolean {
  if (box === undefined) {
    return false;
  }
  const NodeType = box.ownerDocument.defaultView?.Node;
  if (NodeType === undefined || !(target instanceof NodeType)) {
    return false;
  }
  if (box.contains(target)) {
    return true;
  }
  return inOwnedPopup(target, box);
}

/** While mounted, refuse wheel and touch scrolling that does not belong to `boxRef`. */
export function usePopupScrollLock(boxRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const onWheel = (event: Event): void => {
      if (!wheelBelongsTo(boxRef.current ?? undefined, event.target ?? undefined)) {
        event.preventDefault();
      }
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    document.addEventListener('touchmove', onWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('touchmove', onWheel, { capture: true });
    };
  }, [boxRef]);
}

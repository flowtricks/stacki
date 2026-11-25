import { useEffect, useLayoutEffect, useState } from 'react';
import { panelSpan } from '../model/panelBox';

// Anchor to the clicked label's bottom-left, then clamp into the panel and flip above
// the label if it would run off the bottom. Portaled to the body so no card overflow /
// stacking context can clip it.
export function useAnchoredPosition(ref: React.RefObject<HTMLDivElement>, anchor: DOMRect) {
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: anchor.left,
    top: anchor.bottom + 6,
  });
  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) {
      return;
    }
    const margin = 8;
    const { width, height } = popover.getBoundingClientRect();
    // Horizontally the popover belongs to the panel, not the window — clamping
    // to the viewport would let it hang off the panel's left edge.
    const span = panelSpan(popover);
    let left = anchor.left;
    let top = anchor.bottom + 6;
    if (left + width > span.left + span.width) {
      left = span.left + span.width - width;
    }
    if (left < span.left) {
      left = span.left;
    }
    if (top + height > window.innerHeight - margin) {
      const above = anchor.top - 6 - height;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
    }
    setPosition({ left, top });
  }, [anchor, ref]);
  return position;
}

// Dismiss on a pointerdown anywhere outside the popover, or on Escape. Mounted after
// the opening click, so that click can't immediately close it.
export function useProvenanceDismiss({
  ref,
  anchor,
  prop,
  onClose,
  onAnchorReclick,
}: {
  ref: React.RefObject<HTMLDivElement>;
  anchor: DOMRect;
  prop: string;
  onClose: () => void;
  onAnchorReclick: (prop: string) => void;
}) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) {
        return;
      }
      // Pressing back on the label that opened this popover toggles it closed —
      // flag it so that label's click doesn't immediately re-open it.
      if (event.clientX >= anchor.left && event.clientX <= anchor.right && event.clientY >= anchor.top && event.clientY <= anchor.bottom) {
        onAnchorReclick(prop);
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, onAnchorReclick, anchor, prop, ref]);
}

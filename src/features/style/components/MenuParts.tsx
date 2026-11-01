// The parts every dropdown in the style panel is built from: the chevron, the
// plus glyph, a radio menu item, dismissing an open menu, and the tooltip
// arrow's offset. Each section carried an identical copy of these.

import { useEffect } from 'react';
import type { CSSProperties, RefObject } from 'react';

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export function MenuItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// While the menu is open, a press outside the control or Escape closes it.
export function useMenuDismiss({ open, rootRef, setOpen }: { open: boolean; rootRef: RefObject<HTMLDivElement>; setOpen: (open: boolean) => void }): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, rootRef, setOpen]);
}

/** A tooltip's arrow, `arrowRight` pixels from its right edge. */
export function tooltipArrowStyle(arrowRight: number): CSSProperties & { readonly '--tip-arrow-right': string } {
  return { '--tip-arrow-right': `${arrowRight}px` };
}

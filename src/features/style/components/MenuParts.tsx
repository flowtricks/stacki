import { centralIcon } from '../../../ui/central/CentralIcon';
import { add as centralAdd, chevronDown as centralChevronDown } from '../../../ui/central/centralGeometry';
// The parts every dropdown in the style panel is built from: the chevron, the
// plus glyph, a radio menu item, dismissing an open menu, and the tooltip
// arrow's offset. Each section carried an identical copy of these.

import { useEffect } from 'react';
import type { CSSProperties, RefObject } from 'react';

export const ChevronIcon = centralIcon(centralChevronDown);

export const PlusIcon = centralIcon(centralAdd);

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

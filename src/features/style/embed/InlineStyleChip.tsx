// The "Inline styles" chip: the last in the selector well, standing for the selected
// element's `style` attribute (useInlineTarget.ts). Amber in every state, so it never
// reads as a selector: it is not one, and it outranks them all. Clicking it makes the
// attribute the edit target; clicking it again leaves it. Right-click, or its `⋯`,
// offers to clear the attribute.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { MenuSurface, menuBoxBelow, type MenuItem } from '../../../ui/MoreMenu';
import { MoreIcon } from '../../../ui/Icons';
import { INLINE_STYLE_LABEL } from '../model/inlineTarget';
import type { InlineChip } from './useInlineTarget';

const MENU_WIDTH_PX = 170;

export function InlineStyleChip({ chip, busy }: { readonly chip: InlineChip; readonly busy: boolean }): ReactNode {
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items: readonly MenuItem[] = chip.onClear === undefined ? [] : [{ label: 'Clear inline styles', danger: true, onSelect: chip.onClear }];
  assert(items.length <= 1, 'InlineStyleChip: one action');
  const openAt = (rect: DOMRect): void => {
    if (items.length === 0) {
      return;
    }
    setBox(menuBoxBelow(rect, items.length, MENU_WIDTH_PX));
    setOpen(true);
  };
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={inlineChipClassName(chip)}
        disabled={busy}
        aria-pressed={chip.active}
        aria-label={inlineChipLabel(chip)}
        title={inlineChipTitle(chip)}
        onClick={() => {
          if (chip.active) {
            chip.onDeselect();
          } else {
            chip.onSelect();
          }
        }}
        onContextMenu={(event) => {
          if (items.length === 0) {
            return;
          }
          event.preventDefault();
          openAt(new DOMRect(event.clientX, event.clientY, 0, 0));
        }}
      >
        {chip.state === 'code' ? <CodeGlyph /> : <StyleGlyph />}
        <span className="embed-editor_selector-chip-text">{INLINE_STYLE_LABEL}</span>
      </button>
      {items.length > 0 ? (
        <button
          type="button"
          className="embed-editor_inline-chip-more"
          title="Inline styles options"
          aria-label="Inline styles options"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            if (open) {
              setOpen(false);
            } else {
              openAt(event.currentTarget.getBoundingClientRect());
            }
          }}
        >
          <MoreIcon size={12} />
        </button>
      ) : undefined}
      {box ? (
        <MenuSurface
          open={open}
          anchor={chipRef.current ?? undefined}
          rows={items}
          box={box}
          width={MENU_WIDTH_PX}
          menuRef={menuRef}
          close={() => setOpen(false)}
        />
      ) : undefined}
    </>
  );
}

/** The chip's classes: its own colour family, then its state. */
export function inlineChipClassName(chip: Pick<InlineChip, 'state' | 'active'>): string {
  return ['embed-editor_selector-chip', 'is-inline', chip.state === 'code' && 'is-code', chip.active && 'is-active'].filter(Boolean).join(' ');
}

export function inlineChipTitle(chip: Pick<InlineChip, 'state' | 'active'>): string {
  if (chip.state === 'code') {
    return `${INLINE_STYLE_LABEL} — written as code, edited in Settings`;
  }
  return chip.active ? `${INLINE_STYLE_LABEL} — click to deselect` : `${INLINE_STYLE_LABEL} — this element’s style attribute`;
}

function inlineChipLabel(chip: Pick<InlineChip, 'state'>): string {
  return chip.state === 'code' ? `${INLINE_STYLE_LABEL}, written as code` : INLINE_STYLE_LABEL;
}

// A brush: styles written on the element itself.
function StyleGlyph(): ReactNode {
  return (
    <svg className="embed-editor_inline-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5 13.5 5.5 8 11 5 8Z" />
      <path d="M5 8 3.5 9.5C2.5 10.5 3 12.5 2.5 13.5 3.5 13 5.5 13.5 6.5 12.5L8 11" />
    </svg>
  );
}

// Braces: an attribute written as code.
function CodeGlyph(): ReactNode {
  return (
    <svg className="embed-editor_inline-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3C4.5 3 4.5 4 4.5 5.5S4 8 3 8c1 0 1.5 1 1.5 2.5S4.5 13 6 13M10 3c1.5 0 1.5 1 1.5 2.5S12 8 13 8c-1 0-1.5 1-1.5 2.5S11.5 13 10 13" />
    </svg>
  );
}

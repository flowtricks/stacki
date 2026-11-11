import React, { useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import Popup from './Popup';
import { MoreIcon } from './Icons';
import { popupBox } from './Dropdown';

// The `⋯` that opens a short menu of things to do to the thing beside it.
//
// It portals to <body>, because the thing beside it is usually inside
// something that scrolls or clips, and a menu that gets cut off by its own row
// is worse than no menu. That is also why the rows are styled here rather than
// inherited: outside the panel, the app's base button rule centres them.

export interface MenuItem {
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A key that does the same, muted at the end of the row (the rail's More menu shows each panel's). */
  readonly shortcut?: string;
  /** The row is what is open now (the rail's active panel); it keeps a fill. */
  readonly current?: boolean;
  readonly onSelect?: () => void;
}
interface MoreMenuProps {
  readonly items?: readonly (MenuItem | false | undefined)[];
  readonly title?: string;
  readonly className?: string;
  readonly width?: number;
  /** What the button shows, when the menu is not the usual `⋯`. */
  readonly icon?: React.ReactNode;
  /**
   * Where the menu opens: `below` the button, its right edges aligned (the default), or
   * to its `right`, its bottom edges aligned, for a button on the window's left edge (the rail).
   */
  readonly side?: 'below' | 'right';
}
export default function MoreMenu({ items, title = 'Options', className = '', width = 150, icon, side = 'below' }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  assert((items?.length ?? 0) <= LIMITS.scanEntriesMax, 'MoreMenu: item limit exceeded');
  assert(width > 0, 'MoreMenu: positive menu width');
  const rows = (items || []).filter((item): item is MenuItem => Boolean(item));
  if (!rows.length) {
    return undefined;
  }

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const wantedPx = rows.length * MENU_ROW_PX + MENU_PADDING_PX;
    setBox(side === 'right' ? besideBox(rect, wantedPx) : belowBox(rect, wantedPx, width));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`more-menu-button ${className} ${open ? 'is-open' : ''}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          // The row underneath usually does something of its own — opens a
          // folder, picks an asset, starts a rename.
          event.stopPropagation();
          event.preventDefault();
          if (open) {
            setOpen(false);
          } else {
            show();
          }
        }}
      >
        {icon ?? <MoreIcon size={13} />}
      </button>
      {box ? (
        <MenuSurface open={open} anchor={buttonRef.current ?? undefined} rows={rows} box={box} width={width} menuRef={menuRef} close={() => setOpen(false)} />
      ) : undefined}
    </>
  );
}

/** A row's height and the menu's padding, for placing it before it is drawn (styles.css `.more-menu`). */
const MENU_ROW_PX = 30;
const MENU_PADDING_PX = 12;
const MENU_EDGE_PX = 8;

/** Where a menu of `rowCount` rows opens under an anchor (or a pointer) at `rect`,
 *  for a menu opened from something other than this button (a right-click). */
export function menuBoxBelow(rect: DOMRect, rowCount: number, width: number): CSSProperties {
  assert(rowCount > 0, 'menuBoxBelow: a menu has rows');
  return belowBox(rect, rowCount * MENU_ROW_PX + MENU_PADDING_PX, width);
}

function belowBox(rect: DOMRect, wantedPx: number, width: number): CSSProperties {
  assert(wantedPx > 0, 'MoreMenu: a menu has height');
  const left = Math.max(MENU_EDGE_PX, Math.min(rect.right - width, window.innerWidth - width - MENU_EDGE_PX));
  return { left, ...popupBox(rect, wantedPx, window.innerHeight) };
}

// Beside the button, ending level with its bottom so a menu opened from the foot
// of a column grows up, and kept inside the window both ways.
function besideBox(rect: DOMRect, wantedPx: number): CSSProperties {
  assert(wantedPx > 0, 'MoreMenu: a menu has height');
  const roomPx = window.innerHeight - 2 * MENU_EDGE_PX;
  const heightPx = Math.min(wantedPx, roomPx);
  const top = Math.max(MENU_EDGE_PX, Math.min(rect.bottom - heightPx, window.innerHeight - heightPx - MENU_EDGE_PX));
  return { left: rect.right + MENU_EDGE_PX, top, ...(wantedPx > roomPx ? { maxHeight: roomPx, overflowY: 'auto' } : {}) };
}

export interface MenuSurfaceProps {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  readonly rows: readonly MenuItem[];
  readonly box: CSSProperties;
  readonly width: number;
  readonly menuRef: RefObject<HTMLDivElement>;
  readonly close: () => void;
}
export function MenuSurface({ rows, box, width, menuRef, close, open, anchor }: MenuSurfaceProps) {
  return (
    <Popup
      mode="popover"
      open={open}
      anchor={anchor}
      onClose={close}
      ref={menuRef}
      className="more-menu"
      role="menu"
      style={{ position: 'fixed', ...box, minWidth: width }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {({ finish }) =>
        rows.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`more-menu-item ${item.danger ? 'is-danger' : ''} ${item.current ? 'is-current' : ''}`}
            aria-current={item.current ? 'true' : undefined}
            disabled={item.disabled}
            onClick={(event) => {
              event.stopPropagation();
              finish(() => {
                close();
                item.onSelect?.();
              });
            }}
          >
            {item.icon}
            {item.label}
            {item.shortcut !== undefined && <span className="more-menu-shortcut">{item.shortcut}</span>}
          </button>
        ))
      }
    </Popup>
  );
}

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
  readonly onSelect?: () => void;
}
interface MoreMenuProps {
  readonly items?: readonly (MenuItem | false | undefined)[];
  readonly title?: string;
  readonly className?: string;
  readonly width?: number;
  /** What the button shows, when the menu is not the usual `⋯`. */
  readonly icon?: React.ReactNode;
}
export default function MoreMenu({ items, title = 'Options', className = '', width = 150, icon }: MoreMenuProps) {
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
    const place = popupBox(rect, rows.length * 30 + 12, window.innerHeight);
    setBox({
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      ...place,
    });
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

interface MenuSurfaceProps {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  readonly rows: readonly MenuItem[];
  readonly box: CSSProperties;
  readonly width: number;
  readonly menuRef: RefObject<HTMLDivElement>;
  readonly close: () => void;
}
function MenuSurface({ rows, box, width, menuRef, close, open, anchor }: MenuSurfaceProps) {
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
            className={`more-menu-item ${item.danger ? 'is-danger' : ''}`}
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
          </button>
        ))
      }
    </Popup>
  );
}

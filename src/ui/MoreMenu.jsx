import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreIcon } from './Icons.jsx';
import useDismiss from './useDismiss.js';
import { popupBox } from './Dropdown.jsx';

// The `⋯` that opens a short menu of things to do to the thing beside it.
//
// It portals to <body>, because the thing beside it is usually inside
// something that scrolls or clips, and a menu that gets cut off by its own row
// is worse than no menu. That is also why the rows are styled here rather than
// inherited: outside the panel, the app's base button rule centres them.

export default function MoreMenu({ items, title = 'Options', className = '', width = 150 }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  useDismiss(menuRef, open, () => setOpen(false));

  const rows = (items || []).filter(Boolean);
  if (!rows.length) return null;

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const place = popupBox(rect, rows.length * 30 + 12, window.innerHeight);
    setBox({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), ...place });
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
        onClick={(e) => {
          // The row underneath usually does something of its own — opens a
          // folder, picks an asset, starts a rename.
          e.stopPropagation();
          e.preventDefault();
          if (open) setOpen(false);
          else show();
        }}
      >
        <MoreIcon size={13} />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={menuRef}
              className="more-menu"
              role="menu"
              style={{
                position: 'fixed',
                left: box.left,
                top: box.top,
                bottom: box.bottom,
                maxHeight: box.maxHeight,
                minWidth: width,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {rows.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`more-menu-item ${item.danger ? 'is-danger' : ''}`}
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

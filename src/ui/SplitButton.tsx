// A button with a chevron beside it that opens a short menu of related actions:
// the welcome screen's "Open from folder ⌄" and the Apps panel's "Connect
// GitHub release ⌄". The menu drops from under the pair as one control, and
// holds only the alternatives: the main action is the button itself, so the
// menu never repeats it. The class names are the welcome screen's
// (src/app/styles.css), which hold the shared geometry; each place colours it
// in its own stylesheet.
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { ChevronDownIcon } from './Icons';
import Popup from './Popup';

export interface SplitButtonItem {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
}

/** Menu rows a split button holds: a few related actions, never a list. */
const SPLIT_ITEMS_MAX = 6;

export interface SplitButtonProps {
  readonly className: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly menuTitle: string;
  /** The alternatives to the main action, in menu order; never the main action itself. */
  readonly items: readonly SplitButtonItem[];
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export default function SplitButton(props: SplitButtonProps) {
  assert(props.items.length > 0, 'A split button has a menu');
  assert(props.items.length <= SPLIT_ITEMS_MAX, 'A split button menu is short');
  assert(
    props.items.every((item) => item.label !== props.label),
    'A split button menu holds the alternatives, not the main action',
  );
  const [open, setOpen] = useState(false);
  // How the menu was opened. Only a keyboard open moves focus into it: a
  // pointer open that focused the first row drew its focus ring at once, a
  // ring that says "you are here" to someone who is not using the keyboard.
  const [openedBy, setOpenedBy] = useState<'keyboard' | 'pointer'>('pointer');
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const openByKeyboard = () => {
    setOpenedBy('keyboard');
    setOpen(true);
    // Already open from a pointer: the rows are there, so step into the first.
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  };
  return (
    <div className="welcome-split-button" ref={groupRef}>
      <button
        className={props.className}
        disabled={props.disabled}
        onClick={() => {
          setOpen(false);
          props.onClick();
        }}
      >
        {props.icon}
        {props.label}
      </button>
      <button
        ref={triggerRef}
        className={`welcome-split-arrow ${props.className}`}
        disabled={props.disabled}
        aria-label={props.menuTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          if (open) {
            setOpen(false);
          } else if (event.detail === 0) {
            // Enter or Space: a click with no pointer presses behind it.
            openByKeyboard();
          } else {
            setOpenedBy('pointer');
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openByKeyboard();
          }
        }}
      >
        <ChevronDownIcon size={13} />
      </button>
      <Popup
        mode="popover"
        portal={false}
        open={open}
        anchor={triggerRef.current ?? undefined}
        within={groupRef.current ?? undefined}
        onClose={() => setOpen(false)}
        ref={menuRef}
        className="welcome-split-menu"
        role="menu"
        id={menuId}
      >
        {({ finish }) =>
          props.items.map((item, index) => (
            <button
              key={item.label}
              autoFocus={index === 0 && openedBy === 'keyboard'}
              role="menuitem"
              onClick={() =>
                finish(() => {
                  setOpen(false);
                  item.onSelect();
                })
              }
            >
              {item.icon}
              {item.label}
            </button>
          ))
        }
      </Popup>
    </div>
  );
}

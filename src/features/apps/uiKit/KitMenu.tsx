// The app UI kit's `<stacki-menu>`: a ⋯ button that opens a short menu of
// actions. It is the editor's menu as its dropdowns draw it (Dropdown.tsx's
// popup and rows, dropdown.css), opened from a button the way MoreMenu.tsx opens
// its menu: anchored to the button, above it when there is no room below, closed
// by Escape or a click outside. Each row is an icon on the left, the label, its
// shortcut as a muted hint, and a check at the end, so icons line up down the
// left edge whether or not a row is checked; a separator is a 1px line between
// runs of rows. Rows are the element's data (kitElements.tsx); this component only
// draws them and says which was chosen.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { popupBox } from '../../../ui/Dropdown';
import { CheckIcon, MoreIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';

/** One row of a kit menu, or a line between rows. */
export type KitMenuEntry =
  | ({ readonly kind: 'item' } & KitMenuItem)
  | { readonly kind: 'separator' }
  /** A label over the rows below it (the connected account), drawn as the dropdown's group headings are. */
  | { readonly kind: 'heading'; readonly label: string };

/** One row of a kit menu. */
export interface KitMenuItem {
  readonly value: string;
  /** The row's key, shown muted before the check (`⌘D`); undefined for none. */
  readonly shortcut: string | undefined;
  readonly label: string;
  readonly icon: ReactNode;
  /** Undefined for an action; true or false for a row that shows a check. */
  readonly checked: boolean | undefined;
  readonly disabled: boolean;
  readonly danger: boolean;
}

/** Rows a menu draws; the element reads no more (kitElements.tsx). */
export const KIT_MENU_ITEMS_MAX = 64;
/** A row's height and the popup's padding, as dropdown.css draws them, for placing the popup before it is drawn. */
const ROW_HEIGHT_PX = 26;
const POPUP_PADDING_PX = 10;
const MENU_WIDTH_PX = 180;
const WINDOW_EDGE_PX = 8;

export function KitMenu(props: {
  readonly items: readonly KitMenuEntry[];
  /** The button's accessible name (and tooltip). */
  readonly label: string;
  /** What the button shows; the ⋯ when undefined. */
  readonly icon: ReactNode;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
}) {
  assert(props.items.length <= KIT_MENU_ITEMS_MAX, 'A kit menu draws a bounded number of rows');
  assert(props.label.length > 0, 'A kit menu button has a name');
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (): void => {
    setBox(undefined);
    buttonRef.current?.focus();
  };
  const show = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      return;
    }
    setBox(anchoredBox(rect, { heightPx: props.items.length * ROW_HEIGHT_PX + POPUP_PADDING_PX, widthPxMin: MENU_WIDTH_PX }));
    // The first row takes focus once the popup is drawn, so the keyboard can move through it.
    requestAnimationFrame(() => rows(menuRef.current ?? undefined)[0]?.focus());
  };
  const choose = (item: KitMenuItem): void => {
    if (item.disabled) {
      return;
    }
    close();
    props.onSelect(item.value);
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ghost stacki-kit-menu-button"
        title={props.label}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={box !== undefined}
        disabled={props.disabled}
        onClick={() => (box === undefined ? show() : close())}
      >
        {props.icon ?? <MoreIcon size={13} />}
      </button>
      {box !== undefined && (
        <Popup
          mode="popover"
          open={true}
          anchor={buttonRef.current ?? undefined}
          onClose={close}
          ref={menuRef}
          className="dd-popup stacki-kit-menu"
          role="menu"
          label={props.label}
          style={box}
        >
          <div className="dd-list" onKeyDown={(event) => moveFocus(event, menuRef.current ?? undefined)}>
            {props.items.map((entry, index) =>
              entry.kind === 'separator' ? (
                <div key={`separator-${index}`} className="dd-separator" role="separator" />
              ) : entry.kind === 'heading' ? (
                <div key={`heading-${index}`} className="dd-group-label" role="presentation">
                  {entry.label}
                </div>
              ) : (
                <MenuRow key={`${entry.value}-${index}`} item={entry} choose={choose} />
              ),
            )}
          </div>
        </Popup>
      )}
    </>
  );
}

function MenuRow({ item, choose }: { readonly item: KitMenuItem; readonly choose: (item: KitMenuItem) => void }) {
  // The row with focus (the pointer's or the keyboard's) is the dropdown's highlighted row, drawn by dropdown.css.
  const [highlighted, setHighlighted] = useState(false);
  return (
    <div
      className={`dd-option${item.disabled ? ' disabled dim' : ''}${item.danger ? ' is-danger' : ''}${highlighted && !item.disabled ? ' highlight' : ''}`}
      onFocus={() => setHighlighted(true)}
      onBlur={() => setHighlighted(false)}
      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={item.checked}
      aria-disabled={item.disabled ? true : undefined}
      tabIndex={-1}
      onMouseEnter={(event) => {
        setHighlighted(true);
        event.currentTarget.focus();
      }}
      onMouseLeave={(event) => setHighlighted(document.activeElement === event.currentTarget)}
      onClick={() => choose(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose(item);
        }
      }}
    >
      {item.icon !== undefined && <span className="dd-icon">{item.icon}</span>}
      <span className="dd-option-label">{item.label}</span>
      {item.shortcut !== undefined && <span className="dd-hint">{item.shortcut}</span>}
      <span className="dd-check">{item.checked === true ? <CheckIcon size={11} /> : undefined}</span>
    </div>
  );
}

/**
 * Where a popup anchored to a button goes, in the window: below it, or above
 * when there is more room there (Dropdown.tsx popupBox, the editor's flip). A
 * button in the right half of the window lines the popup's right edge up with
 * its own and lets it grow leftwards; one in the left half lines up the left
 * edges. Either way the popup is never wider than the room on its side, so it
 * stays inside the window (an app's frame) however long its rows are.
 */
export function anchoredBox(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>,
  wanted: { readonly heightPx: number; readonly widthPxMin: number },
  windowSize: { readonly widthPx: number; readonly heightPx: number } = { widthPx: window.innerWidth, heightPx: window.innerHeight },
): CSSProperties {
  assert(wanted.heightPx >= 0, 'A popup wants a height');
  assert(windowSize.widthPx >= 0, 'A window has a width');
  const vertical = popupBox(rect, wanted.heightPx, windowSize.heightPx);
  const roomPx = (side: number): number => Math.max(0, side - WINDOW_EDGE_PX);
  if ((rect.left + rect.right) / 2 > windowSize.widthPx / 2) {
    const right = Math.max(WINDOW_EDGE_PX, windowSize.widthPx - rect.right);
    const widthPxMax = roomPx(windowSize.widthPx - right);
    return { ...vertical, right, maxWidth: widthPxMax, minWidth: Math.min(wanted.widthPxMin, widthPxMax) };
  }
  const left = Math.max(WINDOW_EDGE_PX, rect.left);
  const widthPxMax = roomPx(windowSize.widthPx - left);
  return { ...vertical, left, maxWidth: widthPxMax, minWidth: Math.min(wanted.widthPxMin, widthPxMax) };
}

function rows(menu: HTMLElement | undefined): readonly HTMLElement[] {
  return menu === undefined ? [] : [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
}

// ArrowUp and ArrowDown move through the rows, wrapping; Home and End go to the ends.
function moveFocus(event: KeyboardEvent<HTMLElement>, menu: HTMLElement | undefined): void {
  const all = rows(menu);
  if (all.length === 0) {
    return;
  }
  const at = all.findIndex((row) => row === document.activeElement);
  const last = all.length - 1;
  let next: number | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = at < last ? at + 1 : 0;
      break;
    case 'ArrowUp':
      next = at > 0 ? at - 1 : last;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      next = undefined;
  }
  if (next !== undefined) {
    event.preventDefault();
    assert(next >= 0, 'A focused row is a row');
    assert(next <= last, 'A focused row is a row');
    all[next]?.focus();
  }
}

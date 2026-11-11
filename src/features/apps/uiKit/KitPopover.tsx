// The app UI kit's `<stacki-popover>`: a button that opens a small panel of the
// app's own markup beside it (a filter, a date range). It is the editor's Popup
// (src/ui/Popup.tsx) in popover mode, anchored to the button: Escape and a
// click outside close it, focus returns to the button, and it is placed as the
// kit's menu is (KitMenu.tsx anchoredBox), below or above the button and inside
// the window. The panel draws in the editor's popover look (the dropdown's
// popup fill, radius and shadow) inside the kit's scope, so plain controls in it
// take Stacki's style.
//
// The panel's content is the element's own: the element keeps it in one body
// node, and while the popover is open that node moves into the popup and moves
// back when it closes, so the app's listeners and state on it survive.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import Popup from '../../../ui/Popup';
import { anchoredBox } from './KitMenu';

/** The panel's narrowest width; it grows with its content up to the room the window leaves. */
const POPOVER_WIDTH_PX_MIN = 220;
/** The height asked of the flip before the panel is drawn: a few rows of controls. */
const POPOVER_HEIGHT_PX_WANTED = 240;

export function KitPopover(props: {
  readonly open: boolean;
  /** The button's accessible name, and its text when it has no icon. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled: boolean;
  /** The element's body node: moved into the popup while it is open. */
  readonly body: HTMLElement;
  /** Puts the body back in its element when the popup closes. */
  readonly restore: (body: HTMLElement) => void;
  readonly onToggle: (open: boolean) => void;
}) {
  assert(props.label.length > 0, 'A kit popover button has a name');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const button = buttonRef.current ?? undefined;
  const box: CSSProperties | undefined =
    props.open && button !== undefined
      ? anchoredBox(button.getBoundingClientRect(), { heightPx: POPOVER_HEIGHT_PX_WANTED, widthPxMin: POPOVER_WIDTH_PX_MIN })
      : undefined;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={props.icon === undefined ? 'ghost' : 'ghost stacki-kit-icon-button'}
        title={props.icon === undefined ? undefined : props.label}
        aria-label={props.icon === undefined ? undefined : props.label}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        disabled={props.disabled}
        onClick={() => props.onToggle(!props.open)}
      >
        {props.icon ?? props.label}
      </button>
      {props.open && (
        <Popup
          mode="popover"
          open={true}
          anchor={button}
          onClose={() => props.onToggle(false)}
          className="dd-popup stacki-kit-popover"
          role="dialog"
          label={props.label}
          style={box}
        >
          <PopoverBody body={props.body} restore={props.restore} />
        </Popup>
      )}
    </>
  );
}

// The element's body, held in the popup while it shows.
function PopoverBody({ body, restore }: { readonly body: HTMLElement; readonly restore: (body: HTMLElement) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = slot.current ?? undefined;
    assert(target !== undefined, 'The popup slot is mounted before its layout effect');
    target.appendChild(body);
    assert(body.parentNode === target, 'The body shows in the popup');
    return () => restore(body);
  }, [body, restore]);
  return <div ref={slot} className="stacki-kit-popover-slot" />;
}

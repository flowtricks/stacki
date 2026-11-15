// The popup a variable's settings button opens: a small popover (the app's Popup, role "dialog") titled with the
// variable's name, holding one row per setting. A row is an icon, its label, and nothing else; choosing it runs the
// action and closes the popup.
//
// Lifetime: Popup owns it. An outside press, Escape, a scroll that moves the anchor, and a window resize close it, and
// each of them closes it every time; this file never closes it for any other reason. Escape and a choice return focus
// to the settings button; an outside press leaves focus where the press put it.
//
// Keyboard: focus lands on the first row when it opens; Arrow Up/Down, Home and End move between rows; Enter and
// Space choose (a native button); Tab leaves to the next row and Escape closes.
//
// Placement: below the button, flipped above when there is no room, from the button's box at open. It is not moved on
// scroll because a scroll that moves the button closes it.
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import Popup from '../../ui/Popup';
import { placeMenu } from '../../ui/menuModel';
import type { MenuPosition } from '../../ui/menuModel';
import { HideIcon, PreviewIcon } from '../../ui/Icons';
import '../../ui/menu.css';

/** One setting in the popup. */
export interface VariableSettingsAction {
  readonly id: 'hide-from-suggestions' | 'show-in-suggestions';
  readonly label: string;
  readonly onSelect: () => void;
}

export interface VariableSettingsPopupProps {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  /** The heading: the variable's name. */
  readonly title: string;
  /** The popup's accessible name. */
  readonly label: string;
  readonly actions: readonly VariableSettingsAction[];
  readonly onClose: () => void;
}

const POPUP_WIDTH_PX = 240;
// Row 32 + padding 12 + heading 28, before the real size is measured.
const POPUP_HEIGHT_PX_ESTIMATE = 72;

function iconFor(action: VariableSettingsAction): ReactNode {
  return action.id === 'hide-from-suggestions' ? <HideIcon size={14} /> : <PreviewIcon size={14} />;
}

export default function VariableSettingsPopup(props: VariableSettingsPopupProps) {
  assert(props.actions.length > 0, 'VariableSettingsPopup: there is at least one setting');
  const surface = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | undefined)[]>([]);
  const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
  useLayoutEffect(() => {
    if (!props.open || props.anchor === undefined) {
      return;
    }
    const box = props.anchor.getBoundingClientRect();
    const measured = surface.current?.getBoundingClientRect();
    const size = {
      width: measured !== undefined && measured.width > 0 ? measured.width : POPUP_WIDTH_PX,
      height: measured !== undefined && measured.height > 0 ? measured.height : POPUP_HEIGHT_PX_ESTIMATE,
    };
    setPosition(
      placeMenu(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        size,
        { width: window.innerWidth, height: window.innerHeight },
        'below-start',
      ),
    );
  }, [props.open, props.anchor]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const count = props.actions.length;
    const focused = rows.current.findIndex((row) => row !== undefined && row === document.activeElement);
    const keys: Readonly<Record<string, number>> = {
      ArrowDown: Math.min(focused + 1, count - 1),
      ArrowUp: Math.max(focused - 1, 0),
      Home: 0,
      End: count - 1,
    };
    const next = keys[event.key];
    if (next !== undefined) {
      event.preventDefault();
      rows.current[next]?.focus();
    }
  };
  return (
    <Popup
      mode="popover"
      open={props.open}
      anchor={props.anchor}
      onClose={props.onClose}
      ref={surface}
      className="menu-surface vars-settings-popup"
      role="dialog"
      label={props.label}
      style={{ position: 'fixed', left: position?.left ?? 0, top: position?.top ?? 0, minWidth: POPUP_WIDTH_PX }}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {(popup) => (
        <div className="menu-rows">
          <div className="menu-heading vars-settings-title">{props.title}</div>
          {props.actions.map((action, index) => (
            <button
              key={action.id}
              ref={(element) => {
                rows.current[index] = element ?? undefined;
              }}
              type="button"
              className="menu-row"
              // The popup mounts its content after it opens, so focus is taken when the row mounts.
              autoFocus={index === 0}
              onClick={(event) => {
                // One press chooses once: `finish` ignores a second call while the popup is closing, so a double click
                // cannot run the action twice.
                event.stopPropagation();
                popup.finish(() => {
                  props.onClose();
                  action.onSelect();
                });
              }}
            >
              <span className="menu-icon">{iconFor(action)}</span>
              <span className="menu-text">
                <span className="menu-title">
                  <span className="menu-label">{action.label}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Popup>
  );
}

// An editor that opens over the style panel and nowhere else: the grid,
// background, object-position and easing editors. They were <dialog> modals,
// which centre on the window and grey all of it, so they sat over the canvas
// being edited. A sheet is a popover placed within the panel's own bounds
// (published by StylePanel as --style-panel-*), and the panel greys itself
// behind it as it does for every other popup (usePopupOpen); the canvas stays
// in view. It closes on Escape or a press outside, as a popover does.
//
// A sheet with a header can be moved: the header carries
// FLOATING_DRAG_HANDLE_ATTRIBUTE and a press on it (but not on its buttons or
// fields) drags the sheet, kept inside the window. The easing editor opened from
// the variables window covers that window, so it must be movable out of the way.

import type { CSSProperties, ReactNode } from 'react';
import Popup, { type PopupActions } from '../../../ui/Popup';
import { useFloatingDrag } from '../../../ui/useFloatingDrag';
import './PanelSheet.css';

export default function PanelSheet(props: {
  readonly label: string;
  readonly className: string;
  /** A narrower box inside the panel (the easing editor's own frame); the panel's width when absent. */
  readonly style?: CSSProperties | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode | ((actions: PopupActions) => ReactNode);
}) {
  const drag = useFloatingDrag();
  return (
    <Popup
      mode="popover"
      portal={true}
      className={`panel-sheet ${props.className}`}
      style={{ ...props.style, marginLeft: drag.offset.x, marginTop: drag.offset.y }}
      role="dialog"
      label={props.label}
      onClose={props.onClose}
      onPointerDown={drag.onPointerDown}
    >
      {props.children}
    </Popup>
  );
}

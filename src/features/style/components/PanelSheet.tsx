// An editor that opens over the style panel and nowhere else: the grid,
// background, object-position and easing editors. They were <dialog> modals,
// which centre on the window and grey all of it, so they sat over the canvas
// being edited. A sheet is a popover placed within the panel's own bounds
// (published by StylePanel as --style-panel-*), and the panel greys itself
// behind it as it does for every other popup (usePopupOpen); the canvas stays
// in view. It closes on Escape or a press outside, as a popover does.

import type { CSSProperties, ReactNode } from 'react';
import Popup, { type PopupActions } from '../../../ui/Popup';
import './PanelSheet.css';

export default function PanelSheet(props: {
  readonly label: string;
  readonly className: string;
  /** A narrower box inside the panel (the easing editor's own frame); the panel's width when absent. */
  readonly style?: CSSProperties | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode | ((actions: PopupActions) => ReactNode);
}) {
  return (
    <Popup
      mode="popover"
      portal={true}
      className={`panel-sheet ${props.className}`}
      style={props.style}
      role="dialog"
      label={props.label}
      onClose={props.onClose}
    >
      {props.children}
    </Popup>
  );
}

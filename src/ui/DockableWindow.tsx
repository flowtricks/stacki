import { useRef } from 'react';
import type { ReactNode } from 'react';
import { MaximizeIcon, MinimizeIcon } from './Icons';
import { PopupScopeContext, usePopupScope } from './popupScope';
import { useWindowRectangle } from './useWindowRectangle';
import { WindowResizeHandles } from './WindowResizeHandles';
import type { WindowSize } from './windowGeometry';
import './popup.css';
import './dockableWindow.css';

export type WindowMode = 'docked' | 'floating';
interface DockableWindowProps {
  readonly mode: WindowMode;
  readonly onModeChange: (mode: WindowMode) => void;
  readonly label: string;
  readonly header: ReactNode;
  /** Controls after the dock toggle, at the header's far right (an app window's close). */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly minimumSize: WindowSize;
  readonly storageKey?: string;
  /** The floating size before the user has moved or resized it; centered in the viewport. */
  readonly initialSize?: WindowSize;
  readonly hidden?: boolean;
  readonly className?: string;
}

// The dock is owned by the caller, so the same frame can later wrap either sidebar.
// Keep one DOM tree through mode changes: editors retain focus, drafts and scroll position.
export default function DockableWindow(props: DockableWindowProps) {
  const windowState = useWindowRectangle(props.minimumSize, props.storageKey, props.initialSize);
  const { rectangle } = windowState;
  const floating = props.mode === 'floating';
  const surface = useRef<HTMLDivElement>(null);
  const scope = usePopupScope(surface, { active: floating, role: 'dialog', anchor: undefined });
  const action = floating ? 'Dock window' : 'Undock window';
  return (
    <div
      ref={surface}
      className={`popup-surface dockable-window ${props.className ?? ''}`}
      data-window-mode={props.mode}
      hidden={!floating && props.hidden}
      role={floating ? 'dialog' : undefined}
      aria-label={props.label}
      style={
        floating
          ? {
              left: rectangle.x,
              top: rectangle.y,
              width: rectangle.width,
              height: rectangle.height,
            }
          : undefined
      }
    >
      <PopupScopeContext.Provider value={scope}>
        <div
          className="dockable-window-header"
          tabIndex={floating ? 0 : undefined}
          aria-label={floating ? 'Move window with arrow keys' : undefined}
          onPointerDown={floating ? (event) => windowState.start(event) : undefined}
          onKeyDown={floating ? (event) => windowState.onKeyDown(event) : undefined}
        >
          {props.header}
          <button
            className="ghost dockable-window-toggle"
            title={action}
            aria-label={action}
            onClick={() => props.onModeChange(floating ? 'docked' : 'floating')}
          >
            {floating ? <MaximizeIcon size={14} /> : <MinimizeIcon size={14} />}
          </button>
          {props.trailing}
        </div>
        <div className="dockable-window-body">{props.children}</div>
        {floating && <WindowResizeHandles windowState={windowState} />}
      </PopupScopeContext.Provider>
    </div>
  );
}

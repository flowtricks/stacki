import { forwardRef, useLayoutEffect, useRef } from 'react';
import type {
  CSSProperties,
  ForwardedRef,
  ReactNode,
  RefObject,
  RefCallback,
  HTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { POPUP_MOTION_MS, usePopupLifecycle } from './popupLifecycle';
import { usePopupDismiss, popupIsTop } from './popupDismiss';
import './popup.css';
import { PopupScopeContext, usePopupScope } from './popupScope';

export interface PopupActions {
  readonly close: () => void;
  readonly finish: (action: () => void) => void;
}
export interface PopupProps extends Pick<
  HTMLAttributes<HTMLDivElement>,
  | 'onKeyDownCapture'
  | 'aria-activedescendant'
  | 'onKeyDown'
  | 'onMouseDown'
  | 'onPointerDown'
  | 'onMouseEnter'
  | 'onMouseLeave'
  | 'tabIndex'
  | 'id'
> {
  readonly mode?: 'modal' | 'popover';
  readonly portal?: boolean;
  readonly open?: boolean;
  readonly onClose: () => void;
  readonly onEscape?: () => void;
  readonly dismissible?: boolean;
  readonly anchor?: HTMLElement | undefined;
  // A press inside this element is not an outside press: the popup stays open and the click
  // goes through, so a control beside the anchor (a split button's main half) acts at once.
  readonly within?: HTMLElement | undefined;
  readonly className?: string;
  readonly style?: CSSProperties | undefined;
  readonly role?: 'dialog' | 'alertdialog' | 'menu' | 'listbox' | 'tooltip';
  readonly label?: string | undefined;
  readonly labelledBy?: string | undefined;
  readonly children: ReactNode | ((actions: PopupActions) => ReactNode);
}

// All interactive popup surfaces share presence, focus, motion and dismissal.
// Keep controlled popups mounted with open=false so programmatic exits animate too.
const Popup = forwardRef<HTMLDivElement, PopupProps>(function Popup(props, forwardedRef) {
  const mode = props.mode ?? 'modal';
  const lifecycle = usePopupLifecycle({ open: props.open ?? true }, props.onClose);
  const surface = useRef<Parameters<RefCallback<HTMLDivElement>>[0]>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = lifecycle.phase !== 'closed';
  const scope = usePopupScope(surface, { active, anchor: props.anchor, role: props.role });
  usePopupFocus(dialog, surface, { active, mode, anchor: props.anchor });
  usePopupDismiss(surface, { ...props, active, mode }, lifecycle);
  const content = typeof props.children === 'function' ? props.children(lifecycle) : props.children;
  if (!active) {
    return undefined;
  }
  const body = (
    <div
      ref={(element) => {
        // Measurement callers and the popup share one node.
        surface.current = element;
        assignPopupRef(forwardedRef, element);
      }}
      className={`popup-surface ${props.className ?? ''}`}
      style={{ ...props.style, ...popupMotionStyle() }}
      id={props.id}
      tabIndex={props.tabIndex}
      onKeyDown={props.onKeyDown}
      onKeyDownCapture={props.onKeyDownCapture}
      aria-activedescendant={props['aria-activedescendant']}
      onMouseDown={props.onMouseDown}
      onPointerDown={props.onPointerDown}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      data-popup-phase={lifecycle.phase}
      data-popup={mode === 'popover' ? mode : undefined}
      role={mode === 'popover' ? props.role : undefined}
      aria-label={mode === 'popover' ? props.label : undefined}
      aria-labelledby={mode === 'popover' ? props.labelledBy : undefined}
    >
      <PopupScopeContext.Provider value={scope}>{content}</PopupScopeContext.Provider>
    </div>
  );
  if (mode === 'popover' && props.portal === false) {
    return body;
  }
  return createPortal(
    mode === 'modal' ? (
      <dialog
        ref={dialog}
        className="popup-dialog"
        data-popup="modal"
        data-popup-phase={lifecycle.phase}
        style={popupMotionStyle()}
        role={props.role ?? 'dialog'}
        aria-label={props.label}
        aria-labelledby={props.labelledBy}
        onCancel={(event) => {
          event.preventDefault();
          if (props.dismissible !== false && popupIsTop(surface.current)) {
            lifecycle.finish(props.onEscape ?? props.onClose);
          }
        }}
      >
        {body}
      </dialog>
    ) : (
      body
    ),
    popupContainer(mode),
  );
});
export default Popup;

function assignPopupRef(
  ref: ForwardedRef<HTMLDivElement>,
  element: Parameters<RefCallback<HTMLDivElement>>[0],
): void {
  if (typeof ref === 'function') {
    ref(element);
  } else if (ref) {
    ref.current = element;
  }
}

function popupContainer(mode: 'modal' | 'popover'): HTMLElement {
  if (mode === 'popover') {
    // A menu opened from a modal must stay inside its native top layer and focus scope.
    const modals = document.querySelectorAll<HTMLDialogElement>('dialog[data-popup][open]');
    const modal = modals.item(modals.length - 1);
    if (modal) {
      return modal;
    }
  }
  return document.body;
}

function usePopupFocus(
  dialog: RefObject<HTMLDialogElement>,
  surface: RefObject<HTMLDivElement>,
  {
    active,
    mode,
    anchor,
  }: {
    readonly active: boolean;
    readonly mode: 'modal' | 'popover';
    readonly anchor: HTMLElement | undefined;
  },
): void {
  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }
    const previousFocus = document.activeElement;
    const element = dialog.current;
    const content = surface.current;
    if (mode === 'modal') {
      element?.showModal();
    }
    return () => {
      const focused = document.activeElement;
      // Unanchored editors own their focus; restoring their input can reopen them on blur.
      const restore =
        mode === 'modal' ||
        (anchor !== undefined && (focused === document.body || content?.contains(focused)));
      const target = anchor ?? previousFocus;
      element?.close();
      if (restore && target instanceof window.HTMLElement && target.isConnected) {
        target.focus();
      }
    };
  }, [active, anchor, dialog, mode, surface]);
}

function popupMotionStyle(): CSSProperties & { readonly '--popup-duration': string } {
  return { '--popup-duration': `${POPUP_MOTION_MS}ms` };
}

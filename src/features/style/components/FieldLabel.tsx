import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { more as centralMore } from '../../../ui/central/centralGeometry';
import Popup from '../../../ui/Popup';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useInheritedSource } from '../model/computedStyle';
import InheritedPropertyLabel from './InheritedPropertyLabel';
import { panelBounds } from '../model/panelBox';
import { useHoverTip } from './CssPropertyTip';
import type { ScrubHandlers } from './useScrub';

const MoreGlyph = centralIcon(centralMore, 12);

type Props = {
  children: ReactNode;
  /** Unset CSS property whose rendered ancestor may supply the value. */
  inheritedProp?: string;
  /** When true the label highlights (blue) and opens a reset menu on click. */
  active: boolean;
  /** Clears the field. Called from the menu or an Option/Alt-click. */
  onReset: () => void;
  /** Menu item text. Defaults to "Reset". */
  resetLabel?: string;
  /** When true the label is inert (no menu, no reset) — e.g. during a save. */
  disabled?: boolean;
  /** Native title tooltip for the label. */
  title?: string;
  /** Optional content rendered inside the menu, below the reset item — e.g. a note
   *  naming the more specific selector that overrides this value. A function form
   *  receives a `close` callback so an action inside the note can dismiss the menu. */
  menuNote?: ReactNode | ((close: () => void) => ReactNode);
  /** Forwarded to the label so it can double as a drag handle (a drag suppresses
   *  the click, so mousedown-to-drag and click-to-open-menu coexist). */
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  /** Pointer handlers from useScrub, making the label a drag handle for the number in
   *  the field it captions. Same coexistence rule as onMouseDown: a drag eats the click,
   *  a press that stays put still opens the reset menu. Inert while the field is empty —
   *  the dim caption doesn't take pointer events, and there'd be nothing to drag. */
  scrubProps?: ScrubHandlers;
  className?: string;
  /** Shown in a hover tooltip after a short delay, in every state (blue or dim) —
   *  the panel uses it to name the CSS property this label writes. When given, it
   *  replaces the native `title` to keep the tooltip focused on the property name. */
  tooltip?: ReactNode;
};

/**
 * A field caption that mirrors the clip-path label: dim when the field is empty,
 * a blue pill when it has a value. Clicking the active label opens a small menu
 * to reset the field; Option/Alt-clicking it resets immediately. Reusable across
 * tools for any "clearable" input.
 */
export default function FieldLabel(props: Props) {
  const property = props.active ? '' : (props.inheritedProp ?? '');
  const source = useInheritedSource(property);
  if (source) {
    return (
      <InheritedPropertyLabel property={property} source={source} disabled={props.disabled ?? false} className={props.className ?? ''}>
        {props.children}
      </InheritedPropertyLabel>
    );
  }
  return <ClearableFieldLabel {...props} />;
}

function ClearableFieldLabel(props: Props) {
  const translate = useTranslate();
  const { children, active, disabled = false, title, onMouseDown, scrubProps, tooltip } = props;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // The hover tooltip anchors to whichever element this state renders (the dim
  // caption's span or the active pill's wrapper) and swallows the native `title`.
  const hoverTip = useHoverTip<HTMLSpanElement>(tooltip);
  const nativeTitle = tooltip ? undefined : title;
  // While active (the only time the menu can be open), the tooltip's anchor IS the
  // label's root: the wrapper span below.
  const rootRef = hoverTip.ref;
  const dropUp = useMenuPlacement({ open, rootRef, menuRef });

  // If the field is cleared elsewhere, drop back to the plain caption.
  useEffect(() => {
    if (!active) {
      setOpen(false);
    }
  }, [active]);

  if (!active) {
    return <DimCaption props={props} hoverTip={hoverTip} nativeTitle={nativeTitle} />;
  }

  const reset = () => {
    props.onReset();
    setOpen(false);
  };

  const onLabelClick = labelClickHandler({
    disabled,
    reset,
    toggle: () => setOpen((value) => !value),
    hideTip: hoverTip.hide,
  });

  return (
    <span ref={hoverTip.ref} className={['u-field-label-wrap', props.className].filter(Boolean).join(' ')} {...hoverTip.hoverProps}>
      <button
        type="button"
        className="u-field-label is-active"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={nativeTitle}
        onMouseDown={onMouseDown}
        {...scrubProps}
        onClick={onLabelClick}
      >
        {children}
      </button>
      {open ? (
        <FieldLabelMenu
          id={menuId}
          menuRef={menuRef}
          dropUp={dropUp}
          resetLabel={props.resetLabel ?? translate('ui.reset')}
          menuNote={props.menuNote}
          onReset={reset}
          onClose={() => setOpen(false)}
        />
      ) : undefined}
      {/* Portaled to <body>, so nesting it here costs nothing but keeps it with
          the element it's anchored to. */}
      {hoverTip.tip}
    </span>
  );
}

// A click on the active label toggles its menu; Option/Alt-click resets at once.
function labelClickHandler(actions: { readonly disabled: boolean; readonly reset: () => void; readonly toggle: () => void; readonly hideTip: () => void }) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    // preventDefault so this works even when nested in a <label>.
    event.preventDefault();
    actions.hideTip();
    if (actions.disabled) {
      return;
    }
    if (event.altKey) {
      actions.reset();
      return;
    }
    actions.toggle();
  };
}

// A dim caption is normally click-through (it can sit over the field it labels);
// one with a tooltip takes pointer events so it can be hovered. `scrubProps` is the
// drag that changes the value it labels.
function DimCaption({
  props,
  hoverTip,
  nativeTitle,
}: {
  props: Props;
  hoverTip: ReturnType<typeof useHoverTip<HTMLSpanElement>>;
  nativeTitle: string | undefined;
}) {
  return (
    <span
      ref={hoverTip.ref}
      className={['u-field-label', props.tooltip ? 'is-hoverable' : '', props.className].filter(Boolean).join(' ')}
      title={nativeTitle}
      onMouseDown={props.onMouseDown}
      {...props.scrubProps}
      {...hoverTip.hoverProps}
    >
      {props.children}
      {hoverTip.tip}
    </span>
  );
}

// Close on outside click / Escape while open.

function useMenuPlacement({
  open,
  rootRef,
  menuRef,
}: {
  readonly open: boolean;
  readonly rootRef: RefObject<HTMLElement>;
  readonly menuRef: RefObject<HTMLDivElement>;
}): boolean {
  const [dropUp, setDropUp] = useState(false);
  useLayoutEffect(() => {
    const element = menuRef.current;
    const root = rootRef.current;
    if (!open || !element || !root) {
      return;
    }
    const margin = 8;
    const bounds = panelBounds(root);
    const rootRect = root.getBoundingClientRect();
    const naturalRight = rootRect.right;
    const naturalLeft = rootRect.right - element.offsetWidth;
    const leftLimit = bounds.left + margin;
    const rightLimit = bounds.right - margin;
    const next = naturalLeft < leftLimit ? leftLimit - naturalLeft : naturalRight > rightLimit ? rightLimit - naturalRight : 0;
    // `translate`, not `transform`: the popup's own open motion is a transform
    // it transitions, so a transform here replaced it and slid the menu in sideways.
    element.style.translate = next ? `${next}px 0` : '';
    // Vertical flip: if opening below would overflow the container's bottom and
    // there's more room above (a bottom-row label), open the menu above the label.
    const overflowsBelow = rootRect.bottom + element.offsetHeight + margin > bounds.bottom;
    const spaceAbove = rootRect.top - bounds.top;
    const spaceBelow = bounds.bottom - rootRect.bottom;
    setDropUp(overflowsBelow && spaceAbove > spaceBelow);
  }, [open, rootRef, menuRef]);
  return dropUp;
}

function FieldLabelMenu({
  id,
  menuRef,
  dropUp,
  resetLabel,
  menuNote,
  onReset,
  onClose,
}: {
  id: string;
  menuRef: RefObject<HTMLDivElement>;
  dropUp: boolean;
  resetLabel: string;
  menuNote: Props['menuNote'];
  onReset: () => void;
  onClose: () => void;
}) {
  const translate = useTranslate();
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={onClose}
      id={id}
      ref={menuRef}
      className={['u-field-label-menu', dropUp ? 'is-up' : ''].filter(Boolean).join(' ')}
      role="menu"
    >
      <button
        type="button"
        className="u-field-label-menu-item"
        role="menuitem"
        onClick={(event) => {
          // preventDefault so this works even when nested in a <label>.
          event.preventDefault();
          onReset();
        }}
      >
        <MoreGlyph className="u-field-label-menu-icon" />
        <span>{resetLabel}</span>
        <span className="u-field-label-menu-shortcut">{translate('styleModel.shared.optionClick')}</span>
      </button>
      {menuNote ? <div className="u-field-label-menu-note">{typeof menuNote === 'function' ? menuNote(onClose) : menuNote}</div> : undefined}
    </Popup>
  );
}

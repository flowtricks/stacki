// An icon button of the AI panel's header with the app's own tooltip: the same wait, look, fit and layer as every
// other tip (delayedTooltip.ts, FittedTooltip.tsx), naming the button and, when it has one, its shortcut.
// Why not `title`: the native tip is drawn by the operating system, late and unstyled, and a shortcut is told
// only in the app's tip (AGENTS.md, shortcutTip.tsx), never printed on the button.
import { createPortal } from 'react-dom';
import type { ReactNode, Ref } from 'react';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ariaKeyShortcuts } from '../../../lib/shortcutLabel';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from '../../../ui/delayedTooltip';
import FittedTooltip from '../../../ui/FittedTooltip';

interface TipPlacement {
  readonly anchor: TooltipAnchor;
  readonly host: HTMLElement;
}

function placeTip(element: HTMLElement): TipPlacement {
  return { anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) };
}

export interface TipButtonProps {
  /** The button's accessible name and the tip's text. */
  readonly label: string;
  /** A shortcut written for people ("⌘N"); told in the tip only. */
  readonly shortcut?: string | undefined;
  readonly className?: string | undefined;
  /** A toggle's state, for a button that switches something on and off. */
  readonly pressed?: boolean | undefined;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly menu?: { readonly open: boolean } | undefined;
  readonly children: ReactNode;
  readonly onClick: () => void;
}

export function TipButton(props: TipButtonProps) {
  const translate = useTranslate();
  const placement = useDelayedPlacement(placeTip);
  const shown = placement.value;
  const text = props.shortcut === undefined ? props.label : translate('ui.shortcutTip', { label: props.label, shortcut: props.shortcut });
  return (
    <>
      <button
        ref={props.buttonRef}
        type="button"
        className={props.className === undefined ? 'ghost' : `ghost ${props.className}`}
        aria-label={props.label}
        aria-pressed={props.pressed}
        aria-haspopup={props.menu === undefined ? undefined : 'menu'}
        aria-expanded={props.menu?.open}
        aria-keyshortcuts={props.shortcut === undefined ? undefined : ariaKeyShortcuts(props.shortcut)}
        onMouseEnter={(event) => placement.show(event.currentTarget)}
        onMouseLeave={placement.hide}
        onFocus={(event) => placement.show(event.currentTarget)}
        onBlur={placement.hide}
        onClick={() => {
          // A click answers the question the tip would have, so the tip goes.
          placement.hide();
          props.onClick();
        }}
      >
        {props.children}
      </button>
      {shown !== undefined && props.menu?.open !== true
        ? createPortal(
            <FittedTooltip role="tooltip" hidden anchor={shown.anchor}>
              {text}
            </FittedTooltip>,
            shown.host,
          )
        : undefined}
    </>
  );
}

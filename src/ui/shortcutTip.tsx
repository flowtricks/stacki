// The one place a keyboard shortcut is shown next to a row, menu item or button: in the app's own
// tooltip ("CMS (⌥C)"), after the pointer has rested on it or keyboard focus has, and never inline.
//
// Why: a shortcut printed at the end of every row is noise for everyone who does not use it and
// crowds the row's real content; the tip costs nothing until it is asked for. One hook keeps every
// surface (Settings list, menus, context menu, More menu, the apps' menu kit) saying it the same way,
// with the same wait (TOOLTIP_DELAY_MS), the same look (`.rail-tooltip.below`) and the same layer.
import { createPortal } from 'react-dom';
import type { FocusEvent, MouseEvent, ReactNode } from 'react';
import { useTranslate } from '../lib/i18n/useTranslate';
import { ariaKeyShortcuts } from '../lib/shortcutLabel';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from './delayedTooltip';
import FittedTooltip from './FittedTooltip';

interface ShortcutTipPlacement {
  readonly anchor: TooltipAnchor;
  readonly host: HTMLElement;
}

/** What a caller spreads (or calls from its own handlers) on the element the tip belongs to. */
export interface ShortcutTipProps {
  readonly onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  /** Screen readers hear the chord from the element itself, not from the tip, which is `aria-hidden`. */
  readonly 'aria-keyshortcuts': string | undefined;
}

// Pure so it can be tested without a DOM: the tip's position and the layer it joins.
function placeShortcutTip(element: HTMLElement): ShortcutTipPlacement {
  return { anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) };
}

/**
 * The tip for `shortcut`, named by `label`, or nothing when the row has no shortcut. `tip` is rendered next to the element;
 * the element is what the pointer rests on, so the tip never needs its own hit area: it has `pointer-events: none`
 * (`.rail-tooltip`) and cannot block a click.
 */
export function useShortcutTip(label: string, shortcut: string | undefined): { readonly props: ShortcutTipProps; readonly tip: ReactNode } {
  const translate = useTranslate();
  const placement = useDelayedPlacement(placeShortcutTip);
  const hasShortcut = shortcut !== undefined && shortcut.length > 0;
  const props: ShortcutTipProps = {
    onMouseEnter: (event) => {
      if (hasShortcut) {
        placement.show(event.currentTarget);
      }
    },
    onMouseLeave: placement.hide,
    // Keyboard focus waits like the pointer does, so arrowing down a menu does not flash a tip at every row.
    onFocus: (event) => {
      if (hasShortcut) {
        placement.show(event.currentTarget);
      }
    },
    onBlur: placement.hide,
    'aria-keyshortcuts': hasShortcut ? ariaKeyShortcuts(shortcut) : undefined,
  };
  const shown = placement.value;
  const tip =
    shown !== undefined && hasShortcut
      ? createPortal(
          // z-index 10001 clears the popup layer (10000), so the tip also shows over an open menu.
          <FittedTooltip className="shortcut-tip" role="tooltip" hidden anchor={shown.anchor}>
            {/* A `ui.*` key, not the rail's own: the apps' menu kit draws this tip too, and the kit knows only `ui` words (kitTranslate.ts). */}
            {translate('ui.shortcutTip', { label, shortcut })}
          </FittedTooltip>,
          shown.host,
        )
      : undefined;
  return { props, tip };
}

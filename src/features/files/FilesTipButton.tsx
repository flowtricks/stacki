// An icon button of the Files panel with the app's own tooltip (delayedTooltip.ts, FittedTooltip.tsx), never the
// browser's native `title` box, which is drawn late and unstyled by the operating system.
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from '../../ui/delayedTooltip';
import FittedTooltip from '../../ui/FittedTooltip';

function placeTip(element: HTMLElement): { readonly anchor: TooltipAnchor; readonly host: HTMLElement } {
  return { anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) };
}

export function FilesTipButton(props: { readonly label: string; readonly disabled?: boolean; readonly children: ReactNode; readonly onClick: () => void }) {
  const placement = useDelayedPlacement(placeTip);
  const shown = placement.value;
  return (
    <>
      <button
        type="button"
        className="ghost files-icon-button"
        aria-label={props.label}
        disabled={props.disabled}
        title=""
        onMouseEnter={(event) => placement.show(event.currentTarget)}
        onMouseLeave={placement.hide}
        onFocus={(event) => placement.show(event.currentTarget)}
        onBlur={placement.hide}
        onClick={() => {
          placement.hide();
          props.onClick();
        }}
      >
        {props.children}
      </button>
      {shown !== undefined
        ? createPortal(
            <FittedTooltip role="tooltip" hidden anchor={shown.anchor}>
              {props.label}
            </FittedTooltip>,
            shown.host,
          )
        : undefined}
    </>
  );
}

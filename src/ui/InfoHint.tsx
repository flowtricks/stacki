// A small (i) mark that holds the longer explanation a settings card does not spend screen space on: the card shows
// its title, and anything longer than a few words lives here. The tip is the app's own dark `.rail-tooltip`, not
// the native `title` (the operating system draws that one late and in its own place). It is drawn on the body, as
// the menu's info tip is, so a dialog's scroll area and clip never cut it. Inside a modal dialog it is drawn in that dialog
// (tooltipHost), because a modal is in the top layer and paints over anything outside it, whatever the z-index.
// Hovering waits a moment so a pointer passing by does not flash tips; keyboard focus shows the tip at once.
// The text is also the button's description (a hidden element it points at), so a screen reader reads it without
// hovering, while the button's own name stays the short, translated "More information".
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../shared/core/assert';
import { useTranslate } from '../lib/i18n/useTranslate';
import { centralIcon } from './central/CentralIcon';
import { info as centralInfo } from './central/centralGeometry';
import { tooltipHost, tooltipPointBelow, useDelayedPlacement, type TooltipPoint } from './delayedTooltip';
import './infoHint.css';

const InfoIcon = centralIcon(centralInfo, 12);

export default function InfoHint({ text }: { readonly text: string }) {
  assert(text.length > 0, 'InfoHint: the explanation is not empty');
  const translate = useTranslate();
  const descriptionId = useId();
  const tip = useDelayedPlacement(placeTipBelow);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="settings-info"
        aria-label={translate('settings.info.label')}
        aria-describedby={descriptionId}
        onMouseEnter={(event) => tip.show(event.currentTarget)}
        onMouseLeave={tip.hide}
        onFocus={(event) => tip.showNow(event.currentTarget)}
        onBlur={tip.hide}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Escape closes the tip first; a second Escape reaches the dialog.
          if (event.key === 'Escape' && tip.value !== undefined) {
            event.stopPropagation();
            tip.hide();
          }
        }}
      >
        <InfoIcon />
      </button>
      <span id={descriptionId} className="info-hint-text">
        {text}
      </span>
      {tip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below settings-info-tip" style={tip.value} role="tooltip" aria-hidden="true">
            {text}
          </div>,
          tooltipHost(button.current ?? undefined),
        )}
    </>
  );
}

function placeTipBelow(element: HTMLElement): TooltipPoint {
  return tooltipPointBelow(element.getBoundingClientRect());
}

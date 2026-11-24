// Wraps a control (or a row of them) so an explanation lives in a tooltip beside it instead of in a paragraph under it. Why: a
// paragraph that appears and disappears moves everything below it, and the text is gone from the screen the moment the state
// changes; a tooltip takes no room. It is the same dark `.rail-tooltip` as InfoHint, drawn on the body (or in the open dialog),
// shown after a resting pointer or at once on keyboard focus inside, and read by a screen reader through aria-describedby on the
// wrapper, so the explanation is reachable without hovering. A control that is disabled swallows pointer events, but the wrapper
// does not, so the reason a control is off can still be hovered.
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../shared/core/assert';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from './delayedTooltip';
import FittedTooltip from './FittedTooltip';
import './infoHint.css';

interface TipAnchorProps {
  // Undefined when there is nothing to explain right now: the wrapper stays in place, so the control inside is never remounted.
  readonly text: string | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}

export default function TipAnchor({ text, className, children }: TipAnchorProps) {
  assert(text === undefined || text.length > 0, 'TipAnchor: the explanation is not empty');
  const descriptionId = useId();
  const tip = useDelayedPlacement(measureAnchor);
  const wrapper = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={wrapper}
      className={className === undefined ? 'tip-anchor' : `tip-anchor ${className}`}
      aria-describedby={text === undefined ? undefined : descriptionId}
      // An empty title blanks any `title` an ancestor carries, so the browser's native box never covers this tip. A control
      // inside keeps its own title only if it sets one, which nativeTitleCollision.test.ts rejects.
      title={text === undefined ? undefined : ''}
      onMouseEnter={(event) => tip.show(event.currentTarget)}
      onMouseLeave={tip.hide}
      onFocus={(event) => tip.showNow(event.currentTarget)}
      onBlur={tip.hide}
      onKeyDown={(event) => {
        // Escape closes the tip first; a second Escape reaches the dialog.
        if (event.key === 'Escape' && tip.value !== undefined) {
          event.stopPropagation();
          tip.hide();
        }
      }}
    >
      {children}
      {text !== undefined && (
        <span id={descriptionId} className="info-hint-text">
          {text}
        </span>
      )}
      {text !== undefined &&
        tip.value !== undefined &&
        createPortal(
          <FittedTooltip className="settings-info-tip" role="tooltip" hidden anchor={tip.value}>
            {text}
          </FittedTooltip>,
          tooltipHost(wrapper.current ?? undefined),
        )}
    </span>
  );
}

// The wrapper has no box of its own (`display: contents`), so the tip names the first thing it wraps.
function measureAnchor(element: HTMLElement): TooltipAnchor {
  const target = element.firstElementChild ?? element;
  return tooltipAnchor(target.getBoundingClientRect());
}

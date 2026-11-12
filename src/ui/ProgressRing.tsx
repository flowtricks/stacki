// A small circular progress ring: how full something is (the AI panel's context window).
//
// `value` is a fraction from 0 to 1, or undefined while the amount is not known yet (the
// ring then shows its empty track only). The tone says how worried to be: neutral, amber
// when high, red when nearly full; pass `tone` to decide it, or leave it out and the ring
// takes `ringToneFor(value)`. `tooltip` is a slot for a short non-interactive explanation
// shown above the ring on hover and focus; a ring that needs buttons in its pop-up is
// wrapped by the caller in its own Popup instead.
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import Popup from './Popup';
import './progressRing.css';

export type RingTone = 'neutral' | 'amber' | 'red';

export const RING_AMBER_FROM = 0.7;
export const RING_RED_FROM = 0.9;

/** Neutral below 70%, amber from 70%, red from 90%; neutral while the value is unknown. */
export function ringToneFor(value: number | undefined): RingTone {
  if (value === undefined) {
    return 'neutral';
  }
  assert(Number.isFinite(value), 'ringToneFor: value is finite');
  if (value >= RING_RED_FROM) {
    return 'red';
  }
  if (value >= RING_AMBER_FROM) {
    return 'amber';
  }
  return 'neutral';
}

const VIEW_BOX_PX = 20;
// The arc is measured in percent of the circle (pathLength=100 on the circle), so its length
// does not depend on the radius, and the stroke is kept a constant number of screen pixels
// whatever the ring's size, which a plain viewBox scale would not do.
const FULL_LENGTH = 100;
const STROKE_SCREEN_PX_MIN = 2;
const STROKE_SCREEN_PX_MAX = 3;

/** The stroke in viewBox units that draws `STROKE_SCREEN_PX_MIN..MAX` screen pixels: an eighth of the ring, within those bounds. */
function strokeUnits(sizePx: number): number {
  const screenPx = Math.min(STROKE_SCREEN_PX_MAX, Math.max(STROKE_SCREEN_PX_MIN, sizePx / 8));
  return (screenPx * VIEW_BOX_PX) / sizePx;
}

/** How much of the circle is drawn for `value`, in percent of its length; out-of-range values are clamped, never rejected, because a gauge that overshoots should read "full". */
export function ringDrawnLength(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  assert(Number.isFinite(value), 'ringDrawnLength: value is finite');
  return Math.min(1, Math.max(0, value)) * FULL_LENGTH;
}

export interface ProgressRingProps {
  readonly value: number | undefined;
  readonly tone?: RingTone;
  readonly sizePx?: number;
  /** The accessible name, which should carry the reading too ("Context 41% used"). */
  readonly label: string;
  readonly tooltip?: ReactNode;
}

type TooltipState = { readonly kind: 'closed' } | { readonly kind: 'open' | 'closing'; readonly left: number; readonly bottom: number };

export function ProgressRing(props: ProgressRingProps) {
  const sizePx = props.sizePx ?? 16;
  assert(sizePx > 0, 'ProgressRing: positive size');
  const tone = props.tone ?? ringToneFor(props.value);
  const stroke = strokeUnits(sizePx);
  const radius = (VIEW_BOX_PX - stroke) / 2;
  const drawn = ringDrawnLength(props.value);
  const identifier = useId();
  const [tooltip, setTooltip] = useState<TooltipState>({ kind: 'closed' });
  const hasTooltip = props.tooltip !== undefined;
  const show = (element: HTMLElement): void => {
    const rectangle = element.getBoundingClientRect();
    setTooltip({ kind: 'open', left: rectangle.left + rectangle.width / 2, bottom: window.innerHeight - rectangle.top + 8 });
  };
  const hide = (): void => setTooltip((previous) => (previous.kind === 'closed' ? previous : { ...previous, kind: 'closing' }));
  return (
    <>
      <span
        className="progress-ring"
        data-tone={tone}
        role="img"
        aria-label={props.label}
        aria-describedby={tooltip.kind === 'open' ? identifier : undefined}
        tabIndex={hasTooltip ? 0 : undefined}
        style={{ width: sizePx, height: sizePx }}
        onMouseEnter={hasTooltip ? (event) => show(event.currentTarget) : undefined}
        onMouseLeave={hasTooltip ? hide : undefined}
        onFocus={hasTooltip ? (event) => show(event.currentTarget) : undefined}
        onBlur={hasTooltip ? hide : undefined}
      >
        <svg width={sizePx} height={sizePx} viewBox={`0 0 ${VIEW_BOX_PX} ${VIEW_BOX_PX}`} aria-hidden="true" focusable="false">
          <circle className="progress-ring-track" cx={VIEW_BOX_PX / 2} cy={VIEW_BOX_PX / 2} r={radius} strokeWidth={stroke} fill="none" />
          {/* A round cap on an empty dash still paints a dot, so an unknown or zero value draws no arc. */}
          {drawn > 0 && (
            <circle
              className="progress-ring-fill"
              cx={VIEW_BOX_PX / 2}
              cy={VIEW_BOX_PX / 2}
              r={radius}
              strokeWidth={stroke}
              fill="none"
              strokeLinecap="round"
              pathLength={FULL_LENGTH}
              strokeDasharray={`${drawn} ${FULL_LENGTH}`}
              transform={`rotate(-90 ${VIEW_BOX_PX / 2} ${VIEW_BOX_PX / 2})`}
            />
          )}
        </svg>
      </span>
      {tooltip.kind !== 'closed' && hasTooltip && (
        <Popup
          mode="popover"
          role="tooltip"
          id={identifier}
          open={tooltip.kind === 'open'}
          dismissible={false}
          onClose={() => setTooltip({ kind: 'closed' })}
          className="popup-tooltip progress-ring-tooltip"
          style={{ position: 'fixed', left: tooltip.left, bottom: tooltip.bottom, transform: 'translateX(-50%)' }}
        >
          {props.tooltip}
        </Popup>
      )}
    </>
  );
}

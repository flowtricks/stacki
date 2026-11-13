// The gradient editor's geometry controls: a radial gradient's size with its
// icons, and the angle dial with its rotate buttons (GradientEditor.tsx).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { angleToDegrees, degreesToAngle } from './model/gradient';
import { NumberField } from './components/PositionGrid';
import { assert } from '../../../shared/core/assert';
import { tooltipArrowStyle } from './components/MenuParts';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';

export const RADIAL_SIZES = [
  { value: 'closest-side', labelKey: 'style.gradientControls.closestSide', tipKey: 'style.gradientControls.tipClosestSide' },
  { value: 'closest-corner', labelKey: 'style.gradientControls.closestCorner', tipKey: 'style.gradientControls.tipClosestCorner' },
  { value: 'farthest-side', labelKey: 'style.gradientControls.farthestSide', tipKey: 'style.gradientControls.tipFarthestSide' },
  { value: 'farthest-corner', labelKey: 'style.gradientControls.farthestCorner', tipKey: 'style.gradientControls.tipFarthestCorner' },
] as const satisfies ReadonlyArray<{ value: string; labelKey: MessageKey; tipKey: MessageKey }>;

export const RADIAL_SIZE_FARTHEST_SIDE_SECOND_PATH = 'M13.85 5a7.465 7.465 0 00-1.35-3H2v10.5A7.503 7.503 0 0013.85 8H8.5a2.5 2.5 0 110-3h5.35z';

// Webflow's radial-extent icons (closest/farthest × side/corner).
export const RADIAL_SIZE_ICONS: Record<string, ReactNode> = {
  'closest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M1 3v12h14V3h-1v11H2V3H1z" fill="currentColor" />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 4.5a2.5 2.5 0 11-3 0V2H3.337A5.53 5.53 0 002 3.337v6.326A5.5 5.5 0 109.663 2H8v2.5z"
        fill="currentColor"
      />
      <path fillRule="evenodd" clipRule="evenodd" d="M1 1h14v1H7v2.05a2.51 2.51 0 00-1 0V2H1V1z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'closest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M14 2H5V1h10v14H1V5h1v9h12V2z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M2 1H1v3h1V2.707L4.414 5.12c.186-.28.427-.52.707-.706L2.71 2H4V1H2z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 5v6.19A6.5 6.5 0 0011.19 2H5v.88l1.146 1.145a2.5 2.5 0 11-2.12 2.12L2.878 5H2z"
        fill="currentColor"
      />
    </svg>
  ),
  'farthest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M13 2H2v12h11v1H1V1h12v1z" fill="currentColor" />
      <path opacity=".4" fillRule="evenodd" clipRule="evenodd" d={RADIAL_SIZE_FARTHEST_SIDE_SECOND_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M14 1h1v14h-1V7H8.95a2.513 2.513 0 000-1H14V1z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'farthest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M14 2H2v12h9v1H1V1h14v10h-1V2z" fill="currentColor" />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11 13.12V14H2V2h12v9h-.88L8.976 6.854a2.5 2.5 0 10-2.12 2.12L11 13.122z"
        fill="currentColor"
      />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M8.586 7.88c-.186.28-.427.52-.707.706L13.29 14H12v1h3v-3h-1v1.293L8.586 7.88z" fill="currentColor" />
    </svg>
  ),
};

// Radial extent presets with Webflow's icons + delayed description tooltips.
export function RadialSizeControl({ value, busy, onChange }: { value: string; busy: boolean; onChange: (value: string) => void }) {
  const translate = useTranslate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [arrowRight, setArrowRight] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const clearTimer = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => clearTimer, []);
  const start = (size: string, element: HTMLElement) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const root = rootRef.current;
      if (root) {
        const track = root.getBoundingClientRect();
        const button = element.getBoundingClientRect();
        setArrowRight(track.right - (button.left + button.width / 2));
      }
      setHovered(size);
    }, 500);
  };
  const end = () => {
    clearTimer();
    setHovered(undefined);
  };
  const tipKey = RADIAL_SIZES.find((size) => size.value === hovered)?.tipKey;
  const tip = tipKey === undefined ? undefined : translate(tipKey);
  return (
    <div ref={rootRef} className="embed-editor_grad-sizes" role="group" aria-label={translate('style.gradientControls.gradientSize')}>
      {RADIAL_SIZES.map((size) => {
        const active = value === size.value;
        return (
          <button
            key={size.value}
            type="button"
            className={`embed-editor_grad-size ${active ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={translate(size.labelKey)}
            aria-pressed={active}
            onClick={() => {
              end();
              onChange(size.value);
            }}
            onMouseEnter={(event) => start(size.value, event.currentTarget)}
            onMouseLeave={end}
          >
            {RADIAL_SIZE_ICONS[size.value]}
          </button>
        );
      })}
      {hovered && tip ? (
        <div className="u-segmented-tooltip" role="tooltip" style={tooltipArrowStyle(arrowRight)}>
          {tip}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : undefined}
    </div>
  );
}

export const RepeatIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path
      d="M11.5 5.5A4 4 0 0 0 4 6.5M4.5 10.5A4 4 0 0 0 12 9.5M12 4v2h-2M4 12v-2h2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const RotateCcwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M4 4v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4.2 7A4.4 4.4 0 1 1 3.9 9.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
export const RotateCwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M12 4v3H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.8 7A4.4 4.4 0 1 0 12.1 9.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

// The angle dial (linear): drag the dot around the circle to set the gradient's
// direction (0° = up, 90° = right — CSS convention), matching Webflow's control.
export function AngleDial({ deg, busy, onChange }: { deg: number; busy: boolean; onChange: (deg: number, live: boolean) => void }) {
  const translate = useTranslate();
  const ref = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const angleFrom = (event: React.PointerEvent) => {
    // Pointer events only reach the dial through its mounted button.
    const button = ref.current;
    assert(button !== null, 'The angle dial is mounted while it receives pointer events');
    const rect = button.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    return Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
  };
  const onDown = (event: React.PointerEvent) => {
    if (busy) {
      return;
    }
    event.preventDefault();
    dragging.current = true;
    ref.current?.setPointerCapture(event.pointerId);
    onChange(angleFrom(event), true);
  };
  const onMove = (event: React.PointerEvent) => {
    if (dragging.current) {
      onChange(angleFrom(event), true);
    }
  };
  const onUp = (event: React.PointerEvent) => {
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    onChange(angleFrom(event), false);
  };
  const rad = (deg * Math.PI) / 180;
  return (
    <button
      ref={ref}
      type="button"
      className="embed-editor_grad-dial"
      disabled={busy}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-label={translate('style.gradientControls.gradientAngle')}
      title={translate('style.gradientControls.dragAngle')}
    >
      <span className="embed-editor_grad-dial-dot" style={{ left: `${50 + 38 * Math.sin(rad)}%`, top: `${50 - 38 * Math.cos(rad)}%` }} />
    </button>
  );
}

// How an edit lands: live while dragging or typing, or committed.
export interface WriteOptions {
  readonly live: boolean;
}

// Linear angle control: the dial + ±45° rotate buttons + a DEG number field.
export function AngleControl({ angle, busy, onChange }: { angle: string; busy: boolean; onChange: (angle: string, live: boolean) => void }) {
  const translate = useTranslate();
  const deg = angleToDegrees(angle);
  const set = (degrees: number, options: WriteOptions) => onChange(degreesToAngle(degrees), options.live);
  return (
    <div className="embed-editor_grad-angle">
      <AngleDial deg={deg} busy={busy} onChange={(degrees, live) => set(degrees, { live })} />
      <button
        type="button"
        className="embed-editor_grad-rotate"
        disabled={busy}
        title={translate('style.gradientControls.rotateCcwTitle')}
        aria-label={translate('style.gradientControls.rotateCcw')}
        onClick={() => set(deg - 45, { live: false })}
      >
        <RotateCcwIcon />
      </button>
      <button
        type="button"
        className="embed-editor_grad-rotate"
        disabled={busy}
        title={translate('style.gradientControls.rotateCwTitle')}
        aria-label={translate('style.gradientControls.rotateCw')}
        onClick={() => set(deg + 45, { live: false })}
      >
        <RotateCwIcon />
      </button>
      <NumberField
        value={String(Math.round(deg))}
        unit="deg"
        label={translate('style.gradientControls.gradientAngle')}
        busy={busy}
        onLive={(next) => set(angleToDegrees(next), { live: true })}
        onCommit={(next) => set(angleToDegrees(next), { live: false })}
      />
    </div>
  );
}

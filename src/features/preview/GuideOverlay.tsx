import type { CSSProperties } from 'react';
import { assert } from '../../../shared/core/assert';
import { GUIDE_NUMBER_OPACITY, guideColumns, type ResolvedGuide } from './guideModel';
import type { GuideSettings } from './guideModel';
import './guide.css';

// The column guide over the preview: full-height columns pinned to the visible
// part of the page, numbered along the bottom. It is drawn in the overlay
// layer, before the outlines (PreviewPane.tsx), so every selection and spacing
// band paints over it; like the rest of that layer it never takes a click.
//
// Its geometry is in the frame's CSS pixels; the layer is in screen pixels, so
// every box is scaled here, exactly as the outlines are.
export function GuideOverlay({
  guide,
  settings,
  scale,
}: {
  readonly guide: ResolvedGuide;
  readonly settings: Pick<GuideSettings, 'color' | 'numbers' | 'opacity'>;
  readonly scale: number;
}) {
  assert(scale > 0, 'Guide overlay: positive scale');
  const columns = guideColumns(guide);
  return (
    <div className="guide-overlay" aria-hidden="true">
      {columns.map((column, index) => (
        <div key={index} className="guide-column" style={{ left: column.xPx * scale, width: column.widthPx * scale }}>
          <span className="guide-column-fill" style={fillStyle(settings)} />
          {settings.numbers ? (
            <span className="guide-column-number" style={numberStyle(settings)}>
              {index + 1}
            </span>
          ) : undefined}
        </div>
      ))}
    </div>
  );
}

function fillStyle(settings: Pick<GuideSettings, 'color' | 'opacity'>): CSSProperties {
  return { background: settings.color, opacity: settings.opacity };
}

function numberStyle(settings: Pick<GuideSettings, 'color'>): CSSProperties {
  return { color: settings.color, opacity: GUIDE_NUMBER_OPACITY };
}

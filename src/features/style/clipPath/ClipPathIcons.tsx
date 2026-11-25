// The clip-path editor's small glyphs: one per breakpoint, and a preset's
// shape drawn as its own icon (ClipPath.tsx).

import { centralIcon } from '../../../ui/central/CentralIcon';
import { studioDisplay as centralStudioDisplay, phone as centralPhone, tablet as centralTablet } from '../../../ui/central/centralGeometry';
import type { BreakpointId } from './webflowDesigner';
import { type ClipShape } from './clipPathTypes';
import { CORNERS, DEFAULT_SHAPE_PATH_DATA } from './clipPathConstants';

// Landscape is the portrait phone turned a quarter, so every breakpoint comes from Central.
const DesktopIcon = centralIcon(centralStudioDisplay);
const PhoneIcon = centralIcon(centralPhone);
const TabletIcon = centralIcon(centralTablet);

export function BreakpointIcon({ breakpoint }: { breakpoint: BreakpointId }) {
  if (breakpoint === 'medium') {
    return <TabletIcon className="clip-path_source-icon" />;
  }
  if (breakpoint === 'small') {
    return <PhoneIcon className="clip-path_source-icon" style={{ transform: 'rotate(90deg)' }} />;
  }
  if (breakpoint === 'tiny') {
    return <PhoneIcon className="clip-path_source-icon" />;
  }
  // Desktop (main) and all larger breakpoints (large / xl / xxl).
  return <DesktopIcon className="clip-path_source-icon" />;
}

export function PresetIcon({ shape }: { shape: ClipShape }) {
  if (shape.kind === 'none') {
    return (
      <svg className="clip-path_preset-icon" viewBox="-8 -8 116 116" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <line x1="22" y1="78" x2="78" y2="22" />
      </svg>
    );
  }

  const insetIconRadius = shape.kind === 'inset' ? Math.max(36, ...CORNERS.flatMap((corner) => [shape.radii[corner].x, shape.radii[corner].y])) : 0;

  return (
    <svg className="clip-path_preset-icon" viewBox="-8 -8 116 116" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {shape.kind === 'polygon' ? <polygon points={shape.points.map((point) => `${point.x},${point.y}`).join(' ')} /> : undefined}
      {shape.kind === 'circle' ? <circle cx={shape.cx} cy={shape.cy} r={shape.radius} /> : undefined}
      {shape.kind === 'ellipse' ? <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} /> : undefined}
      {shape.kind === 'inset' ? <rect x="0" y="0" width="100" height="100" rx={insetIconRadius} ry={insetIconRadius} /> : undefined}
      {shape.kind === 'shape' ? <path d={shape.pathData || DEFAULT_SHAPE_PATH_DATA} fillRule={shape.fillRule} /> : undefined}
      {shape.kind === 'raw' ? <path d="M16 70C16 42 34 24 56 28C82 32 84 56 62 58C44 60 42 80 62 84C78 88 92 78 92 58" /> : undefined}
    </svg>
  );
}

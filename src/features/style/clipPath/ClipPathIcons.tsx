// The clip-path editor's small glyphs: one per breakpoint, and a preset's
// shape drawn as its own icon (ClipPath.tsx).

import type { BreakpointId } from './webflowDesigner';
import { type ClipShape } from './clipPathTypes';
import { CORNERS, DEFAULT_SHAPE_PATH_DATA } from './clipPathConstants';

export const MEDIUM_BREAKPOINT_ICON_PATH =
  'M3 3C3 2.44772 3.44772 2 4 2H12C12.5523 2 13 2.44772 13 3V13' + 'C13 13.5523 12.5523 14 12 14H4C3.44772 14 3 13.5523 3 13V3ZM4 3H12V13H4V3Z';
export const SMALL_BREAKPOINT_ICON_PATH =
  'M4 12C2.89543 12 2 11.1046 2 10L2 6C2 4.89543 2.89543 4 4 4L12 4C13.1046 4 14 4.89543 14 6' +
  'V10C14 11.1046 13.1046 12 12 12H4ZM3 10L3 6C3 5.44772 3.44772 5 4 5L12 5C12.5523 ' +
  '5 13 5.44772 13 6V10C13 10.5523 12.5523 11 12 11L4 11C3.44772 11 3 10.5523 3 10Z';
export const TINY_BREAKPOINT_ICON_PATH =
  'M4 4C4 2.89543 4.89543 2 6 2H10C11.1046 2 12 2.89543 12 4V12C12 13.1046 11.1046 ' +
  '14 10 14H6C4.89543 14 4 13.1046 4 12V4ZM6 3H10C10.5523 3 11 3.44772 11 4V12' +
  'C11 12.5523 10.5523 13 10 13H6C5.44772 13 5 12.5523 5 12V4C5 3.44772 5.44772 3 6 3Z';
export const DESKTOP_BREAKPOINT_ICON_PATH =
  'M12 5.36602L10.1519 6.43301L9.65192 5.56699L11.5 4.5L9.65193 3.43301' +
  'L10.1519 2.56699L12 3.63397V1.5H13V3.63397L14.8481 2.56699L15.3481 3.43301' +
  'L13.5 4.5L15.3481 5.56699L14.8481 6.43301L13 5.36602V7.5H12V5.36602Z';

export function BreakpointIcon({ breakpoint }: { breakpoint: BreakpointId }) {
  if (breakpoint === 'medium') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 11H6.5V12H9.5V11Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={MEDIUM_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  if (breakpoint === 'small') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12 9V7H11V9H12Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={SMALL_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  if (breakpoint === 'tiny') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M7 12H9V11H7V12Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={TINY_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  // Desktop (main) and all larger breakpoints (large / xl / xxl).
  return (
    <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={DESKTOP_BREAKPOINT_ICON_PATH} />
      <path d="M3 4H8V5H3V12H13V9H14V12H16V13H0V12H2V5C2 4.44772 2.44772 4 3 4Z" />
    </svg>
  );
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

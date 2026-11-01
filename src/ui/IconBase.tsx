// The frames every icon is drawn in: a 16px and a 24px stroke grid, and the
// props an icon takes (Icons.tsx).

import type { CSSProperties, ReactNode } from 'react';

export interface IconProps {
  readonly children?: ReactNode;
  readonly size?: number | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly filled?: boolean;
  readonly strokeWidth?: number;
}

// Minimal stroke-based icon set on a 16px grid, Framer-style.
// Astro's brand accent, so anything from astro:assets is identifiable at a
// glance as Astro's rather than the project's or plain HTML's.
export const ASTRO_ASSET_ACCENT = '#ff5d01';

export const I = ({ children, size = 16, className, style, filled = false, strokeWidth = 1.3 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={filled ? 'currentColor' : 'none'}
    stroke={filled ? 'none' : 'currentColor'}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style, pointerEvents: 'none' }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

// Webflow-style filled icons on a 24px grid (used by the left rail).
export const I24 = ({ children, size = 24, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style, pointerEvents: 'none' }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

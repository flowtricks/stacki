import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { IconProps } from '../IconBase';

interface CentralGeometry {
  readonly name: string;
  readonly compact: ReactNode;
  readonly standard: ReactNode;
}

const ICON_SIZES = [12, 16, 20, 24, 32] as const;
type IconSize = (typeof ICON_SIZES)[number];

export function centralIconSize(requested: number): IconSize {
  assert(Number.isFinite(requested), 'Icon size is finite');
  assert(requested > 0, 'Icon size is positive');
  // Round up to a common size so dense controls never lose legibility.
  return ICON_SIZES.find((size) => requested <= size) ?? 32;
}

export function centralIcon(geometry: CentralGeometry, defaultSize: IconSize = 16) {
  return function CentralIcon({ size = defaultSize, className, style, title }: IconProps & { readonly title?: string }) {
    const pixels = centralIconSize(size);
    // Use the stronger of the two light outlines in small controls so they stay legible.
    const compact = pixels <= 16;
    const drawing = compact ? geometry.compact : geometry.standard;
    return (
      <svg
        width={pixels}
        height={pixels}
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth={compact ? 1.5 : 1}
        className={className}
        style={{ display: 'block', flexShrink: 0, pointerEvents: 'none', ...style }}
        aria-hidden="true"
        data-central-icon={geometry.name}
      >
        {title === undefined ? undefined : <title>{title}</title>}
        {drawing}
      </svg>
    );
  };
}

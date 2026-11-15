// The icon of a breakpoint's device, by position in the project's list, never by name: the `up` breakpoint closest to Desktop is
// the studio display and every wider one a television; the built-in Laptop, Tablet and Phone keep theirs; any other `down`
// breakpoint narrower than the Phone one is the smartwatch, and one between wears the nearest of the three by width.
// Shared by the preview bar, Settings and the style panel's context dropdown, so the three never disagree.
import { BREAKPOINT_DEFAULTS, type ResolvedBreakpoint } from './projectBreakpoints';

export type DeviceIconKind = 'desktop' | 'laptop' | 'tablet' | 'phone' | 'studioDisplayXdr' | 'television' | 'smartwatch' | 'canvas';

const FIXED_WIDTH_ICONS: ReadonlyArray<{ readonly minWidthPx: number; readonly icon: DeviceIconKind }> = [
  { minWidthPx: 895, icon: 'laptop' },
  { minWidthPx: 623, icon: 'tablet' },
  { minWidthPx: 0, icon: 'phone' },
];

/** The icon of one breakpoint within its list. */
export function iconFor(breakpoint: ResolvedBreakpoint, resolved: readonly ResolvedBreakpoint[]): DeviceIconKind {
  if (breakpoint.direction === 'up') {
    const ups = resolved.filter((other) => other.direction === 'up');
    const closest = ups[ups.length - 1];
    return closest !== undefined && closest.id === breakpoint.id ? 'studioDisplayXdr' : 'television';
  }
  if (breakpoint.id === 'laptop' || breakpoint.id === 'tablet' || breakpoint.id === 'phone') {
    return breakpoint.id;
  }
  const phone = resolved.find((other) => other.id === 'phone');
  const phoneWidthPx = phone?.widthPx ?? BREAKPOINT_DEFAULTS.find((other) => other.id === 'phone')?.widthPx ?? 479;
  if (breakpoint.widthPx < phoneWidthPx) {
    return 'smartwatch';
  }
  return FIXED_WIDTH_ICONS.find((entry) => breakpoint.widthPx >= entry.minWidthPx)?.icon ?? 'phone';
}

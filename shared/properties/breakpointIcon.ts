// The icon of a breakpoint's device, by position in the project's list, never by name: the `up` breakpoint closest to Desktop is
// the studio display and every wider one a television; the built-in Laptop, Tablet and Phone keep theirs; any other `down`
// breakpoint narrower than the Phone one is the smartwatch, and one between wears the nearest of the three by width.
// Shared by the preview bar, Settings and the style panel's context dropdown, so the three never disagree.
import { assert } from '../core/assert';
import { BREAKPOINT_DEFAULTS, BREAKPOINT_LIMITS, type ResolvedBreakpoint } from './projectBreakpoints';

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

// The canvas's device, the one answer the preview bar's pressed button and the style panel's breakpoint trigger both read, so the
// trigger can never wear a device the bar does not show. Desktop and the all-breakpoints canvas are picked by name and keep it at any
// width (Desktop fills whatever room the pane has); every other device, a dragged custom width included, is the device that width
// belongs to.

/**
 * The device a canvas width belongs to. An `up` breakpoint holds every width from its own (the widest one that fits); between the
 * widest `down` canvas and the smallest `up` one is Desktop; each `down` one holds up to its canvas, the narrowest that fits.
 */
export function deviceForWidth(px: number, resolved: readonly ResolvedBreakpoint[]): string | undefined {
  assert(resolved.length <= BREAKPOINT_LIMITS.countMax, 'deviceForWidth: the breakpoint list is within its bound');
  if (!Number.isFinite(px) || px <= 0) {
    return undefined;
  }
  for (const breakpoint of resolved) {
    if (breakpoint.direction === 'up' && px >= breakpoint.widthPx) {
      return breakpoint.id;
    }
  }
  const downs = resolved.filter((breakpoint) => breakpoint.direction === 'down');
  for (const breakpoint of [...downs].reverse()) {
    if (px <= breakpoint.widthPx) {
      return breakpoint.id;
    }
  }
  return 'desktop';
}

/** The device the preview bar shows pressed: `device` is the one picked (`desktop`, `canvas`, `custom` or a breakpoint id). */
export function activeDeviceFor(device: string, widthPx: number, resolved: readonly ResolvedBreakpoint[]): string {
  assert(device.length > 0, 'activeDeviceFor: a device is named');
  if (device === 'canvas' || device === 'desktop') {
    return device;
  }
  return deviceForWidth(widthPx, resolved) ?? device;
}

/** The icon of a device key, as the bar draws it, or undefined for a key that is no device (`custom` before a width is known). */
export function deviceIconOf(device: string, resolved: readonly ResolvedBreakpoint[]): DeviceIconKind | undefined {
  if (device === 'desktop' || device === 'canvas') {
    return device;
  }
  assert(resolved.length <= BREAKPOINT_LIMITS.countMax, 'deviceIconOf: the breakpoint list is within its bound');
  const breakpoint = resolved.find((candidate) => candidate.id === device);
  return breakpoint === undefined ? undefined : iconFor(breakpoint, resolved);
}

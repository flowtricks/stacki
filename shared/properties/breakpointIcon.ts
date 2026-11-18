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
// width (Desktop's own width is desktopCanvasWidth's); every other device, a dragged custom width included, is the device that width
// belongs to.

/** Where the Desktop device draws the page: filling the pane (`fill`), or at a fixed width the canvas scales to fit. */
export type DesktopCanvasWidth = { readonly kind: 'fill' } | { readonly kind: 'fixed'; readonly widthPx: number };

/**
 * The width the Desktop device draws the page at, for a pane `availablePx` wide. Desktop is the layout no breakpoint query applies
 * to: at least the Desktop frame width from Settings (90rem, 1440px by default) and wider than every narrower (`down`, `width < X`)
 * breakpoint, below every wider (`up`) one. A pane inside that range is filled; a narrower pane gets the frame width, scaled down to
 * fit, never the pane's own width: that would apply the Laptop query (`width < 64rem` at 882px) under the Desktop button, and the
 * style panel following the canvas would edit Laptop. A wider pane than the widest Desktop width shows that width, centred.
 * In a desktop-first component Base is then the query in effect; in a mobile-first one, the widest `width >= X` query.
 * The preview bar, the canvas frame and so the style panel's follow (which reads the width the canvas reports) share this answer.
 */
export function desktopCanvasWidth(availablePx: number, resolved: readonly ResolvedBreakpoint[], desktopFramePx: number): DesktopCanvasWidth {
  assert(resolved.length <= BREAKPOINT_LIMITS.countMax, 'desktopCanvasWidth: the breakpoint list is within its bound');
  assert(Number.isSafeInteger(desktopFramePx), 'desktopCanvasWidth: the Desktop frame is whole pixels');
  assert(desktopFramePx > 0, 'desktopCanvasWidth: the Desktop frame is positive');
  const range = desktopWidthRange(resolved, desktopFramePx);
  // An unmeasured pane (0 before the first layout) fills, as it always did: there is no width to scale against yet.
  if (!Number.isFinite(availablePx) || availablePx <= 0) {
    return { kind: 'fill' };
  }
  if (availablePx < range.widthPxMin) {
    return { kind: 'fixed', widthPx: range.widthPxMin };
  }
  if (availablePx <= range.widthPxMax) {
    return { kind: 'fill' };
  }
  return { kind: 'fixed', widthPx: range.widthPxMax };
}

// The widths no breakpoint query applies at: from the Desktop frame (and one pixel past the widest `down` canvas, the first width its
// `width < X` no longer holds) to one pixel under the narrowest `up` canvas (the first width its `width >= X` holds).
function desktopWidthRange(resolved: readonly ResolvedBreakpoint[], desktopFramePx: number): { readonly widthPxMin: number; readonly widthPxMax: number } {
  let widthPxMin = desktopFramePx;
  let widthPxMax = Number.MAX_SAFE_INTEGER;
  for (const breakpoint of resolved) {
    if (breakpoint.direction === 'down') {
      widthPxMin = Math.max(widthPxMin, breakpoint.widthPx + 1);
    } else {
      widthPxMax = Math.min(widthPxMax, breakpoint.widthPx - 1);
    }
  }
  // Settings derive each direction from Desktop's width (projectBreakpoints.ts directionOf), so the range is never empty.
  assert(widthPxMin <= widthPxMax, 'desktopCanvasWidth: Desktop has a width no breakpoint query applies at');
  assert(Number.isSafeInteger(widthPxMin), 'desktopCanvasWidth: the narrowest Desktop width is whole pixels');
  return { widthPxMin, widthPxMax };
}

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

/** The device the preview bar shows pressed: `device` is the one picked (`desktop`, `canvas`, `custom` or a breakpoint id). Desktop
 *  draws at desktopCanvasWidth, where no breakpoint query applies, so it stays pressed at any pane width. */
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

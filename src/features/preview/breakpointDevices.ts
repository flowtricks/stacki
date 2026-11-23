// The devices of the preview bar, from the project's breakpoints (`.stacki/breakpoints.json`, shared/properties/projectBreakpoints.ts).
//
// The bar reads left to right: the `up` breakpoints widest first, Desktop (the base: the full pane width), the `down` breakpoints widest
// first, then the all-breakpoints canvas. A device is named by its breakpoint's id (`laptop`, `bp-1`), or `desktop`, `canvas` or
// `custom` (a dragged width); the shortcuts 1 to 9 are the bar's positions, so they follow the list.
//
// The icon is chosen by position, never by name: the `up` breakpoint closest to Desktop is the studio display and every wider one
// a television; the built-in Laptop, Tablet and Phone keep theirs; any other `down` breakpoint narrower than the Phone one is the
// smartwatch, and one between wears the nearest of the three by width.
import type { Breakpoint, ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { activeDeviceFor, deviceForWidth, iconFor, type DeviceIconKind } from '../../../shared/properties/breakpointIcon';

// The device a width belongs to, and the one the bar shows pressed, live beside the icons so the style panel reads the same answer.
export { activeDeviceFor, deviceForWidth, iconFor, type DeviceIconKind };

/** `desktop`, `canvas`, `custom`, or a breakpoint's id. */
export type PreviewDevice = string;

export interface BarDevice {
  readonly key: PreviewDevice;
  readonly icon: DeviceIconKind;
  /** The breakpoint it stands for; undefined for Desktop and the canvas. */
  readonly breakpoint: ResolvedBreakpoint | undefined;
}

/** The shortcuts bind digits 1 to 9. */
export const SHORTCUTS_MAX = 9;

/** The bar's devices in order. */
export function barDevices(resolved: readonly ResolvedBreakpoint[]): readonly BarDevice[] {
  const device = (breakpoint: ResolvedBreakpoint): BarDevice => ({ key: breakpoint.id, icon: iconFor(breakpoint, resolved), breakpoint });
  return [
    ...resolved.filter((breakpoint) => breakpoint.direction === 'up').map(device),
    { key: 'desktop', icon: 'desktop', breakpoint: undefined },
    ...resolved.filter((breakpoint) => breakpoint.direction === 'down').map(device),
    { key: 'canvas', icon: 'canvas', breakpoint: undefined },
  ];
}

/** The viewport width a breakpoint device simulates; undefined for any other (Desktop fills the pane, a custom drag has its own width). */
export function deviceWidth(device: PreviewDevice, resolved: readonly ResolvedBreakpoint[]): number | undefined {
  return resolved.find((breakpoint) => breakpoint.id === device)?.widthPx;
}

/** The device a digit key selects: the bar's position of that digit, or undefined past the bar. */
export function deviceForShortcut(key: string, resolved: readonly ResolvedBreakpoint[]): PreviewDevice | undefined {
  if (!/^[1-9]$/.test(key)) {
    return undefined;
  }
  return barDevices(resolved)[Number(key) - 1]?.key;
}

/** A device's shortcut digit, or undefined when it sits past the ninth position. */
export function shortcutOf(device: BarDevice, devices: readonly BarDevice[]): number | undefined {
  const position = devices.findIndex((other) => other.key === device.key) + 1;
  return position >= 1 && position <= SHORTCUTS_MAX ? position : undefined;
}

export type BreakpointNameSource = Pick<Breakpoint, 'id' | 'name'>;

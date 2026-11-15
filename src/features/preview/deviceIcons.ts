// The icon component of each device kind, shared by the preview bar and the Breakpoints cards so a card and its button always match.
// A module of its own so Settings does not pull in the whole toolbar.
import type { ComponentType } from 'react';
import type { IconProps } from '../../ui/Icons';
import { AllBreakpointsIcon, DesktopIcon, LaptopIcon, PhoneIcon, SmartwatchIcon, StudioDisplayXdrIcon, TabletIcon, TelevisionIcon } from '../../ui/Icons';
import type { DeviceIconKind } from './breakpointDevices';

const DEVICE_ICONS: Readonly<Record<DeviceIconKind, ComponentType<IconProps>>> = {
  desktop: DesktopIcon,
  laptop: LaptopIcon,
  tablet: TabletIcon,
  phone: PhoneIcon,
  studioDisplayXdr: StudioDisplayXdrIcon,
  television: TelevisionIcon,
  smartwatch: SmartwatchIcon,
  canvas: AllBreakpointsIcon,
};

/** The icon component of a device kind. */
export function deviceIconComponent(kind: DeviceIconKind): ComponentType<IconProps> {
  return DEVICE_ICONS[kind];
}

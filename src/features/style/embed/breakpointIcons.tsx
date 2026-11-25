// The icons a breakpoint wears in the style panel: the preview bar's and Settings' device icons
// (shared/properties/breakpointIcon.ts chooses the kind), and a ruler for a width that is no breakpoint.
import type { ReactNode } from 'react';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { ruler as centralRuler } from '../../../ui/central/centralGeometry';
import { DesktopIcon, LaptopIcon, PhoneIcon, SmartwatchIcon, StudioDisplayXdrIcon, TabletIcon, TelevisionIcon } from '../../../ui/Icons';
import type { DeviceIconKind } from '../../../../shared/properties/breakpointIcon';

export const WidthIcon = centralIcon(centralRuler);

const DEVICE_ICONS: Readonly<Record<DeviceIconKind, () => ReactNode>> = {
  desktop: () => <DesktopIcon />,
  laptop: () => <LaptopIcon />,
  tablet: () => <TabletIcon />,
  phone: () => <PhoneIcon />,
  studioDisplayXdr: () => <StudioDisplayXdrIcon />,
  television: () => <TelevisionIcon />,
  smartwatch: () => <SmartwatchIcon />,
  canvas: () => <DesktopIcon />,
};
// The preview bar's and Settings' icon for a breakpoint.
export const deviceIcon = (kind: DeviceIconKind): ReactNode => DEVICE_ICONS[kind]();

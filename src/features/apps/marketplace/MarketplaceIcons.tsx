// The marketplace's two icons, on the 16px stroke grid (src/ui/IconBase.tsx): a
// storefront for the marketplace itself, and a tray with a downward arrow for
// installing from it. The Apps panel's Marketplace tab, the palette's
// marketplace rows and the Roles grid (src/app/featureIcons.tsx) all draw these.
import { I, type IconProps } from '../../../ui/IconBase';

export const MarketplaceIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.5 6.5V13.5H13.5V6.5" />
    <path d="M1.75 6 3 2.5h10L14.25 6c0 1-.85 1.75-1.9 1.75S10.4 7 10.1 6c-.3 1-1.1 1.75-2.1 1.75S6.2 7 5.9 6c-.3 1-1.15 1.75-2.25 1.75S1.75 7 1.75 6Z" />
    <path d="M6.5 13.5V10.5H9.5V13.5" />
  </I>
);

export const MarketplaceInstallIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 2.5v7M5 6.75 8 9.75l3-3" />
    <path d="M2.5 10.5v2.25c0 .4.35.75.75.75h9.5c.4 0 .75-.35.75-.75V10.5" />
  </I>
);

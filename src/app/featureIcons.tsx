import { centralIcon, centralIconSize } from '../ui/central/CentralIcon';
import { roles as centralRoles } from '../ui/central/centralGeometry';
// One icon per access feature (shared/properties/projectRoles.ts), so a panel
// looks the same wherever Stacki names it: its left-rail button, the Settings
// tab list and the Roles permission grid. A panel's icon is the one its rail
// button draws; a feature without a rail button gets the closest icon from
// src/ui/Icons.tsx. The record is total over the features, so adding a feature
// is a compile error here until it has an icon.
import type { ComponentType } from 'react';
import { I, type IconProps } from '../ui/IconBase';
import {
  AppsIcon,
  AssetManagerIcon,
  BracesIcon,
  CmsIcon,
  ComponentEditIcon,
  ComponentFillIcon,
  ComponentPlusIcon,
  DropletIcon,
  FolderIcon,
  GearIcon,
  GitHubIcon,
  HistoryIcon,
  InstructionsIcon,
  LayoutIcon,
  MoreIcon,
  NavigatorIcon,
  PagePanelIcon,
  PencilIcon,
  PlusIcon,
  SparkleIcon,
  StackiMarkIcon,
  TrashIcon,
  UploadCloudIcon,
  VariableIcon,
} from '../ui/Icons';
import { PropertiesIcon } from '../features/componentProperties/PropertiesIcon';
import { StyleSelectorsIcon } from '../features/selectors/SelectorIcons';
import { MarketplaceIcon, MarketplaceInstallIcon } from '../features/apps/marketplace/MarketplaceIcons';
import { APP_ACCESS_ALL, type StaticAccessFeature } from '../../shared/properties/projectRoles';
export type FeatureIconComponent = ComponentType<Pick<IconProps, 'size'>>;

// Two people: the Roles tab and the roles feature.
const RolesIcon = centralIcon(centralRoles);

// A clipboard with a check: the Audits panel's findings and fixes.
export const AuditsIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.85}>
    <path d="M5.5 3.2H4.7a1.7 1.7 0 0 0-1.7 1.7v7a1.7 1.7 0 0 0 1.7 1.7h6.6a1.7 1.7 0 0 0 1.7-1.7v-7a1.7 1.7 0 0 0-1.7-1.7h-.8" />
    <rect x="5.5" y="2" width="5" height="2.5" rx="0.8" />
    <path d="m5.7 9 1.5 1.5 3.1-3.2" />
  </I>
);

const RailCodeIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 20)} strokeWidth={0.85}>
    <path d="M5.2 4.9 2.2 8l3 3.1M10.8 4.9l3 3.1-3 3.1M9.3 3.7l-2.6 8.6" />
  </I>
);

export const FEATURE_ICONS: Readonly<Record<StaticAccessFeature, FeatureIconComponent>> = {
  // The left rail's buttons (LeftRail.tsx, and Studio's EditorRail.tsx).
  'panel:pages': PagePanelIcon,
  'panel:navigator': NavigatorIcon,
  'panel:properties': PropertiesIcon,
  'panel:components': ComponentFillIcon,
  'panel:assets': AssetManagerIcon,
  'panel:cms': CmsIcon,
  'panel:variables': VariableIcon,
  'panel:selectors': StyleSelectorsIcon,
  'panel:code': RailCodeIcon,
  'panel:history': HistoryIcon,
  'panel:apps': AppsIcon,
  'panel:ai': SparkleIcon,
  'panel:instructions': InstructionsIcon,
  'panel:audits': AuditsIcon,
  // The right panels' tabs are text; these are the closest icons.
  'panel:style': DropletIcon,
  'panel:settings': GearIcon,
  'page:create': PlusIcon,
  'page:delete': TrashIcon,
  'page:rename': PencilIcon,
  'page:layout': LayoutIcon,
  'component:create': ComponentPlusIcon,
  'component:edit': ComponentEditIcon,
  'code:edit': BracesIcon,
  'instructions:edit': PencilIcon,
  publish: UploadCloudIcon,
  // The Apps panel's Marketplace tab, and its Install button.
  'marketplace:view': MarketplaceIcon,
  'marketplace:install': MarketplaceInstallIcon,
  'marketplace:publish': UploadCloudIcon,
  'apps:share': GitHubIcon,
  // The Settings tabs (Settings.tsx).
  'settings:editor': GearIcon,
  'settings:folders': FolderIcon,
  'settings:cms': CmsIcon,
  'settings:studio': StackiMarkIcon,
  'settings:instructions': InstructionsIcon,
  'settings:audits': AuditsIcon,
  'settings:roles': RolesIcon,
};

/** The rail's More button (RailMore.tsx), shared by Desktop and Studio. */
export const RailMoreIcon: FeatureIconComponent = MoreIcon;

/** The icon for an app grant: every app, or one app, is the Apps panel's icon. */
export const APP_GRANT_ICON: FeatureIconComponent = FEATURE_ICONS['panel:apps'];

export function FeatureIcon(props: { readonly feature: StaticAccessFeature | typeof APP_ACCESS_ALL; readonly size: number }) {
  const Icon = props.feature === APP_ACCESS_ALL ? APP_GRANT_ICON : FEATURE_ICONS[props.feature];
  return <Icon size={props.size} />;
}

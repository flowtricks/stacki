import { centralIcon } from '../ui/central/CentralIcon';
import { gauge as centralGauge, roles as centralRoles, codeBrackets as centralCodeBrackets } from '../ui/central/centralGeometry';
// One icon per access feature (shared/properties/projectRoles.ts), so a panel
// looks the same wherever Stacki names it: its left-rail button, the Settings
// tab list and the Roles permission grid. A panel's icon is the one its rail
// button draws; a feature without a rail button gets the closest icon from
// src/ui/Icons.tsx. The record is total over the features, so adding a feature
// is a compile error here until it has an icon.
import type { ComponentType } from 'react';
import type { IconProps } from '../ui/IconBase';
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

// A check in a circle: the Audits panel's findings and fixes. Central has no clipboard-with-check glyph yet.
// A gauge: audits score a page, and a plain check circle read like a done marker.
export const AuditsIcon = centralIcon(centralGauge, 20);

// Code brackets with a slash: the Code panel shows source, and the bare chevrons read like every tag.
const RailCodeIcon = centralIcon(centralCodeBrackets, 20);

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
  'panel:projectSettings': GearIcon,
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

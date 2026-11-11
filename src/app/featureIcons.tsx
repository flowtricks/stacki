// One icon per access feature (shared/properties/projectRoles.ts), so a panel
// looks the same wherever Stacki names it: its left-rail button, the Settings
// tab list and the Roles permission grid. A panel's icon is the one its rail
// button draws; a feature without a rail button gets the closest icon from
// src/ui/Icons.tsx. The record is total over the features, so adding a feature
// is a compile error here until it has an icon.
//
// The rail's panels draw from one of three sets (RAIL_ICONS), chosen in
// Settings → Editor → Rail icons (railIconSet.ts), and every place that names a
// panel follows the choice, so the rail and the Roles grid still match.
import type { ComponentType } from 'react';
import type { IconProps } from '../ui/IconBase';
import { I } from '../ui/IconBase';
import { assert } from '../../shared/core/assert';
import {
  AppsIcon,
  AssetManagerIcon,
  BracesIcon,
  CmsIcon,
  CodeIcon,
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
import { CUSTOM_RAIL_ICONS, PHOSPHOR_RAIL_ICONS, RAIL_ICON_KEYS, type RailIconKey, type RailIconMap } from '../ui/railIcons';
import { useRailIconSet, type RailIconSet } from './railIconSet';

export type FeatureIconComponent = ComponentType<Pick<IconProps, 'size'>>;

// Two people: the Roles tab and the roles feature.
const RolesIcon = (props: Pick<IconProps, 'size'>) => (
  <I size={props.size}>
    <circle cx="6" cy="5.5" r="2.2" />
    <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" />
    <path d="M10.5 3.6a2.2 2.2 0 0 1 0 3.8M11.5 9.7c1.3.4 2.2 1.5 2.5 3.3" />
  </I>
);

// A clipboard with a check: the Audits panel's findings and fixes.
export const AuditsIcon = (props: Pick<IconProps, 'size'>) => (
  <I size={props.size}>
    <rect x="3" y="2.75" width="10" height="11" rx="2" />
    <path d="M6.25 2.75h3.5v1.5h-3.5z" />
    <path d="M5.75 9.1l1.6 1.6 2.9-3.2" />
  </I>
);

// Stacki's own rail icons, as they were before the sets were compared.
const STACKI_RAIL_ICONS: RailIconMap = {
  pages: PagePanelIcon,
  navigator: NavigatorIcon,
  properties: PropertiesIcon,
  components: ComponentFillIcon,
  assets: AssetManagerIcon,
  cms: CmsIcon,
  variables: VariableIcon,
  selectors: StyleSelectorsIcon,
  code: CodeIcon,
  history: HistoryIcon,
  apps: AppsIcon,
  // Studio's rail draws the AI button as a sparkle; this is that sparkle as an icon.
  ai: SparkleIcon,
  instructions: InstructionsIcon,
  audits: AuditsIcon,
  more: MoreIcon,
};

/** Every set, each total over the rail's buttons. */
export const RAIL_ICONS: Readonly<Record<RailIconSet, RailIconMap>> = {
  stacki: STACKI_RAIL_ICONS,
  phosphor: PHOSPHOR_RAIL_ICONS,
  custom: CUSTOM_RAIL_ICONS,
};

/** A rail button's icon in the set Settings chose; it redraws when the choice changes. */
export function railIcon(key: RailIconKey): FeatureIconComponent {
  assert(RAIL_ICON_KEYS.includes(key), 'A rail icon names one of the rail buttons');
  const RailIcon = (props: Pick<IconProps, 'size'>) => {
    const Icon = RAIL_ICONS[useRailIconSet()][key];
    return <Icon size={props.size} />;
  };
  return RailIcon;
}

export const FEATURE_ICONS: Readonly<Record<StaticAccessFeature, FeatureIconComponent>> = {
  // The left rail's buttons (LeftRail.tsx, and Studio's EditorRail.tsx).
  'panel:pages': railIcon('pages'),
  'panel:navigator': railIcon('navigator'),
  'panel:properties': railIcon('properties'),
  'panel:components': railIcon('components'),
  'panel:assets': railIcon('assets'),
  'panel:cms': railIcon('cms'),
  'panel:variables': railIcon('variables'),
  'panel:selectors': railIcon('selectors'),
  'panel:code': railIcon('code'),
  'panel:history': railIcon('history'),
  'panel:apps': railIcon('apps'),
  'panel:ai': railIcon('ai'),
  'panel:instructions': railIcon('instructions'),
  'panel:audits': railIcon('audits'),
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

/** The rail's More button (RailMore.tsx), drawn in the chosen set like the buttons beside it. */
export const RailMoreIcon: FeatureIconComponent = railIcon('more');

/** The icon for an app grant: every app, or one app, is the Apps panel's icon. */
export const APP_GRANT_ICON: FeatureIconComponent = FEATURE_ICONS['panel:apps'];

export function FeatureIcon(props: { readonly feature: StaticAccessFeature | typeof APP_ACCESS_ALL; readonly size: number }) {
  const Icon = props.feature === APP_ACCESS_ALL ? APP_GRANT_ICON : FEATURE_ICONS[props.feature];
  return <Icon size={props.size} />;
}

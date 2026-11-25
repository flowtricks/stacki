// What each item of the rail order (railOrder.ts) is: its label, its icon and its chord, read by both places an
// item can be drawn, the rail (LeftRail.tsx) as an icon button and the Settings panel's root (SettingsRailRows.tsx)
// as a row. Kept apart from both so neither imports the other.
//
// Two kinds of item: a rail panel (opens in the panel area, `onSelect(id)`) and a Settings view (opens the Settings
// panel at that view, `onOpenSettings(id)`). Each draws its access feature's icon (featureIcons.tsx), the same one
// the Roles permission grid shows, or, for a Settings view, the icon its Settings row has always had.
import { assert } from '../../shared/core/assert';
import type { MessageKey } from '../lib/i18n/localeContext';
import { SETTINGS_VIEW_TITLE_KEYS, type SettingsViewId } from '../lib/settingsSections';
import type { RailContainer } from './railOrder';
import { AgentIcon, InstructionsIcon, LockIcon, PlugIcon } from '../ui/Icons';
import { FEATURE_ICONS, type FeatureIconComponent } from './featureIcons';
import { shortcutOf } from './railShortcuts';

export const RAIL_PANEL_TABS = [
  // Add elements is gated by `panel:elements` (shared/properties/projectRoles.ts); inserting through the palette (⌘K) is not.
  { id: 'elements', titleKey: 'rail.elements', shortcut: shortcutOf('elements'), Icon: FEATURE_ICONS['panel:elements'] },
  { id: 'pages', titleKey: 'rail.pages', shortcut: shortcutOf('pages'), Icon: FEATURE_ICONS['panel:pages'] },
  { id: 'navigator', titleKey: 'rail.navigator', shortcut: shortcutOf('navigator'), Icon: FEATURE_ICONS['panel:navigator'] },
  { id: 'properties', titleKey: 'rail.properties', shortcut: shortcutOf('properties'), Icon: FEATURE_ICONS['panel:properties'] },
  { id: 'components', titleKey: 'rail.components', shortcut: shortcutOf('components'), Icon: FEATURE_ICONS['panel:components'] },
  { id: 'assets', titleKey: 'rail.assets', shortcut: shortcutOf('assets'), Icon: FEATURE_ICONS['panel:assets'] },
  { id: 'cms', titleKey: 'rail.cms', shortcut: shortcutOf('cms'), Icon: FEATURE_ICONS['panel:cms'] },
  { id: 'variables', titleKey: 'rail.variables', shortcut: shortcutOf('variables'), Icon: FEATURE_ICONS['panel:variables'] },
  { id: 'selectors', titleKey: 'rail.selectors', shortcut: shortcutOf('selectors'), Icon: FEATURE_ICONS['panel:selectors'] },
  { id: 'code', titleKey: 'rail.code', shortcut: shortcutOf('code'), Icon: FEATURE_ICONS['panel:code'] },
  { id: 'history', titleKey: 'rail.history', shortcut: shortcutOf('history'), Icon: FEATURE_ICONS['panel:history'] },
  { id: 'apps', titleKey: 'rail.apps', shortcut: shortcutOf('apps'), Icon: FEATURE_ICONS['panel:apps'] },
  { id: 'audits', titleKey: 'rail.audits', shortcut: shortcutOf('audits'), Icon: FEATURE_ICONS['panel:audits'] },
] as const satisfies readonly { readonly id: string; readonly titleKey: MessageKey; readonly shortcut: string; readonly Icon: unknown }[];

export type RailPanelId = (typeof RAIL_PANEL_TABS)[number]['id'];

/** The Settings views that are items of the rail order: Desktop's root rows. Roles is hosted Studio's and never one. */
export const RAIL_SETTINGS_VIEWS = ['secrets', 'mcp', 'instructions', 'agents'] as const satisfies readonly SettingsViewId[];
export type RailSettingsViewId = (typeof RAIL_SETTINGS_VIEWS)[number];

const SETTINGS_VIEW_ICONS: Readonly<Record<RailSettingsViewId, FeatureIconComponent>> = {
  secrets: LockIcon,
  mcp: PlugIcon,
  instructions: InstructionsIcon,
  agents: AgentIcon,
};

/** What a drawn item needs, whichever kind it is and wherever it lives. */
export type RailItemSpec =
  | {
      readonly kind: 'panel';
      readonly id: RailPanelId;
      readonly titleKey: MessageKey;
      readonly shortcut: string;
      readonly Icon: FeatureIconComponent;
    }
  | {
      readonly kind: 'settingsView';
      readonly id: RailSettingsViewId;
      readonly titleKey: MessageKey;
      /** Agents has no chord: it opens from its row (railShortcuts.ts). */
      readonly shortcut: string | undefined;
      readonly Icon: FeatureIconComponent;
    };

/** The announcement for an item's new place, by the container it is now in. */
export function movedKey(container: RailContainer): 'rail.movedTop' | 'rail.movedBottom' | 'rail.movedSettings' {
  switch (container) {
    case 'top':
      return 'rail.movedTop';
    case 'bottom':
      return 'rail.movedBottom';
    case 'settings':
      return 'rail.movedSettings';
    default: {
      const exhaustive: never = container;
      return exhaustive;
    }
  }
}

export function isRailPanelId(id: string): id is RailPanelId {
  return RAIL_PANEL_TABS.some((tab) => tab.id === id);
}

export function isRailSettingsViewId(id: string): id is RailSettingsViewId {
  return RAIL_SETTINGS_VIEWS.some((view) => view === id);
}

/** The spec of a movable item: a rail panel or a Settings view. Settings and the AI button are drawn by the rail alone. */
export function railItemSpec(id: string): RailItemSpec | undefined {
  assert(id.length > 0, 'A rail item id is never empty');
  const tab = RAIL_PANEL_TABS.find((each) => each.id === id);
  if (tab !== undefined) {
    return { kind: 'panel', id: tab.id, titleKey: tab.titleKey, shortcut: tab.shortcut, Icon: tab.Icon };
  }
  if (isRailSettingsViewId(id)) {
    const shortcut = id === 'agents' ? undefined : shortcutOf(id);
    return { kind: 'settingsView', id, titleKey: SETTINGS_VIEW_TITLE_KEYS[id], shortcut, Icon: SETTINGS_VIEW_ICONS[id] };
  }
  return undefined;
}

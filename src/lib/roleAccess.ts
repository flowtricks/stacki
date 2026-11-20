// The renderer's questions about access, in the terms of its own UI: which rail
// panel, right tab and Settings tab a role sees. The rules are `can()`
// (shared/properties/projectRoles.ts); this only names the feature behind each id.
import { assert } from '../../shared/core/assert';
import { ACCESS_FEATURES, can, type AccessFeature, type RoleView } from '../../shared/properties/projectRoles';
import type { SettingsViewId } from './settingsSections';

/** The feature behind a panel id (`pages` → `panel:pages`); undefined for a panel no role restricts. */
export function panelFeature(id: string): AccessFeature | undefined {
  assert(id.length > 0, 'A panel id is never empty');
  const feature = ACCESS_FEATURES.find((item) => item === `panel:${id}`);
  assert(feature === undefined || feature.startsWith('panel:'), 'A panel feature is a panel');
  return feature;
}

/** Whether `role` sees the panel `id` (a rail tab or a right tab). */
export function canPanel(role: RoleView, id: string): boolean {
  const feature = panelFeature(id);
  return feature === undefined ? true : can(role, feature);
}

/** Whether `role` sees the Settings tab `tab`. Everyone sees Roles (read-only unless admin); tabs without a feature are open. */
export function canSettingsTab(role: RoleView, tab: string): boolean {
  assert(tab.length > 0, 'A settings tab id is never empty');
  if (tab === 'roles') {
    return true;
  }
  const feature = ACCESS_FEATURES.find((item) => item === `settings:${tab}`);
  return feature === undefined ? true : can(role, feature);
}

/**
 * The views the Settings panel's root lists for `role`, in order. Secrets and MCP need `panel:projectSettings`;
 * Instructions needs `panel:instructions`, the access the Instructions panel had before it moved into Settings,
 * so a role granted only that sees Settings with just that link.
 */
export function settingsViewsOf(role: RoleView): readonly SettingsViewId[] {
  const project: readonly SettingsViewId[] = can(role, 'panel:projectSettings') ? ['secrets', 'mcp'] : [];
  const instructions: readonly SettingsViewId[] = can(role, 'panel:instructions') ? ['instructions'] : [];
  return [...project, ...instructions];
}

/** Whether the rail's Settings button shows for `role`: it has at least one view to list. */
export function canSettingsPanel(role: RoleView): boolean {
  return settingsViewsOf(role).length > 0;
}

/** Whether `role` sees the rail tab `id`; Settings is the panel whose access is its views'. */
export function canRailTab(role: RoleView, id: string): boolean {
  return id === 'projectSettings' ? canSettingsPanel(role) : canPanel(role, id);
}

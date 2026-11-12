// The Settings panel's tabs. One record per tab, so a new tab is one entry here and one case in
// ProjectSettingsPanel's switch, which the compiler holds exhaustive over `ProjectSettingsTabId`.
import type { MessageKey } from '../../lib/i18n/localeContext';
import { LockIcon, PlugIcon } from '../../ui/Icons';

export const PROJECT_SETTINGS_TABS = [
  { id: 'secrets', labelKey: 'settings.secrets.tab', Icon: LockIcon },
  { id: 'mcp', labelKey: 'settings.mcp.tab', Icon: PlugIcon },
] as const satisfies readonly {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly Icon: typeof LockIcon;
}[];

export type ProjectSettingsTabId = (typeof PROJECT_SETTINGS_TABS)[number]['id'];

export const PROJECT_SETTINGS_TAB_DEFAULT: ProjectSettingsTabId = PROJECT_SETTINGS_TABS[0].id;

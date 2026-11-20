// English `rail` strings: the source of truth for every key beginning `rail.` (docs/i18n.md). Alphabetical.
// Each key is a stable dotted name; the other four locales hold exactly these keys, checked by the compiler and the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';

export const messages = {
  'rail.ai': 'AI chat',
  'rail.appWaiting': '{name}: {count} waiting',
  'rail.apps': 'Apps',
  'rail.assets': 'Assets',
  'rail.audits': 'Audits',
  'rail.cms': 'CMS',
  'rail.code': 'Code',
  'rail.collections': 'Collections',
  'rail.components': 'Components',
  'rail.editorPanels': 'Editor panels',
  'rail.history': 'Git',
  'rail.more': 'More',
  'rail.moveToBottom': 'Move to bottom group',
  'rail.moveToTop': 'Move to top group',
  'rail.movedBottom': '{label}: bottom group, position {position} of {count}',
  'rail.movedTop': '{label}: top group, position {position} of {count}',
  'rail.navigator': 'Navigator',
  'rail.orderMenu': 'Rail order',
  'rail.pages': 'Pages',
  'rail.properties': 'Properties',
  'rail.reset': 'Reset rail order',
  'rail.resetDone': 'Rail order reset',
  'rail.selectors': 'Style selectors',
  'rail.settings': 'Settings',
  'rail.settingsOrder.alreadyDefault': 'Already default',
  'rail.settingsOrder.description': 'Drag icons in the sidebar to reorder them. Reset to the default order.',
  'rail.settingsOrder.done': 'Sidebar order reset',
  'rail.settingsOrder.label': 'Sidebar icon order',
  'rail.settingsOrder.reset': 'Reset to default',
  'rail.variables': 'Variables',
  'rail.withShortcut': '{label} ({shortcut})',
} as const satisfies CatalogOf<`rail.${string}`>;

export type MessageKey = keyof typeof messages;

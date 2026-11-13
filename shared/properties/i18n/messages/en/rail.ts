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
  'rail.instructions': 'Instructions',
  'rail.more': 'More',
  'rail.navigator': 'Navigator',
  'rail.pages': 'Pages',
  'rail.properties': 'Properties',
  'rail.selectors': 'Style selectors',
  'rail.settings': 'Settings',
  'rail.variables': 'Variables',
  'rail.withShortcut': '{label} ({shortcut})',
} as const satisfies CatalogOf<`rail.${string}`>;

export type MessageKey = keyof typeof messages;

// German `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'KI-Chat',
  'rail.appWaiting': '{name}: {count} wartend',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Assets', // same
  'rail.audits': 'Audits', // same
  'rail.cms': 'CMS', // same
  'rail.code': 'Code', // same
  'rail.collections': 'Sammlungen',
  'rail.components': 'Komponenten',
  'rail.editorPanels': 'Editor-Bereiche',
  'rail.history': 'Git', // same
  'rail.instructions': 'Anweisungen',
  'rail.more': 'Mehr',
  'rail.navigator': 'Navigator', // same
  'rail.pages': 'Seiten',
  'rail.properties': 'Eigenschaften',
  'rail.selectors': 'Stil-Selektoren',
  'rail.settings': 'Einstellungen',
  'rail.variables': 'Variablen',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

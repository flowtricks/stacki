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
  'rail.more': 'Mehr',
  'rail.moveToBottom': 'In die untere Gruppe verschieben',
  'rail.moveToTop': 'In die obere Gruppe verschieben',
  'rail.movedBottom': '{label}: untere Gruppe, Position {position} von {count}',
  'rail.movedTop': '{label}: obere Gruppe, Position {position} von {count}',
  'rail.navigator': 'Navigator', // same
  'rail.orderMenu': 'Reihenfolge der Leiste',
  'rail.pages': 'Seiten',
  'rail.properties': 'Eigenschaften',
  'rail.reset': 'Reihenfolge der Leiste zurücksetzen',
  'rail.resetDone': 'Reihenfolge der Leiste zurückgesetzt',
  'rail.selectors': 'Stil-Selektoren',
  'rail.settings': 'Einstellungen',
  'rail.settingsOrder.description': 'Ziehe die Symbole in der Seitenleiste, um sie umzuordnen. Auf die Standardreihenfolge zurücksetzen.',
  'rail.settingsOrder.done': 'Seitenleistenreihenfolge zurückgesetzt',
  'rail.settingsOrder.label': 'Reihenfolge der Seitenleistensymbole',
  'rail.settingsOrder.reset': 'Auf Standard zurücksetzen',
  'rail.variables': 'Variablen',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

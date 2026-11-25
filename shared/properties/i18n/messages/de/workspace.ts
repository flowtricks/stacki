// German `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Schließen (Änderungen werden sofort gespeichert)',
  'workspace.code.title': 'Code', // same
  'workspace.notifications.dismiss': 'Benachrichtigung schließen',
  'workspace.notifications.label': 'Benachrichtigungen',
  'workspace.notifications.loadMore': 'Mehr laden ({count})',
  'workspace.notifications.showFewer': 'Weniger anzeigen',
  'workspace.terminal.close': 'Terminal schließen',
  'workspace.terminal.custom': 'Benutzerdefiniert …',
  'workspace.terminal.customPlaceholder': 'z. B. bun run watch',
  'workspace.terminal.customTitle': 'Wird einmal in jedem neuen Terminal ausgeführt',
  'workspace.terminal.hide': 'Terminal ausblenden ({shortcut})',
  'workspace.terminal.loading': 'Terminal wird geladen',
  'workspace.terminal.new': 'Neues Terminal',
  'workspace.terminal.resize': 'Zum Ändern der Größe ziehen',
  'workspace.terminal.scrollBottom': 'Nach unten scrollen',
  'workspace.terminal.shellOnly': 'Nur Shell',
} as const satisfies CatalogOf<MessageKey>;

// Italian `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Chiudi (le modifiche vengono salvate in tempo reale)',
  'workspace.code.title': 'Codice',
  'workspace.notifications.copied': 'Copiato',
  'workspace.notifications.copy': 'Copia',
  'workspace.notifications.dismiss': 'Ignora notifica',
  'workspace.notifications.label': 'Notifiche',
  'workspace.notifications.loadMore': 'Carica altre ({count})',
  'workspace.notifications.showFewer': 'Mostra meno',
  'workspace.terminal.close': 'Chiudi terminale',
  'workspace.terminal.custom': 'Personalizzato…',
  'workspace.terminal.customPlaceholder': 'es. bun run watch',
  'workspace.terminal.customTitle': 'Esegui una volta in ogni nuovo terminale',
  'workspace.terminal.hide': 'Nascondi terminale ({shortcut})',
  'workspace.terminal.loading': 'Caricamento del terminale',
  'workspace.terminal.new': 'Nuovo terminale',
  'workspace.terminal.resize': 'Trascina per ridimensionare',
  'workspace.terminal.scrollBottom': 'Vai in fondo',
  'workspace.terminal.shellOnly': 'Solo shell',
} as const satisfies CatalogOf<MessageKey>;

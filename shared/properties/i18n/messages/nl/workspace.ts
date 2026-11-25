// Dutch `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Sluiten (wijzigingen worden direct opgeslagen)',
  'workspace.code.title': 'Code', // same
  'workspace.notifications.copied': 'Gekopieerd',
  'workspace.notifications.copy': 'Kopiëren',
  'workspace.notifications.dismiss': 'Melding sluiten',
  'workspace.notifications.label': 'Meldingen',
  'workspace.notifications.loadMore': 'Meer laden ({count})',
  'workspace.notifications.showFewer': 'Minder tonen',
  'workspace.terminal.close': 'Terminal sluiten',
  'workspace.terminal.custom': 'Aangepast…',
  'workspace.terminal.customPlaceholder': 'bijv. bun run watch',
  'workspace.terminal.customTitle': 'Eenmalig uitvoeren in elke nieuwe terminal',
  'workspace.terminal.hide': 'Terminal verbergen ({shortcut})',
  'workspace.terminal.loading': 'Terminal laden',
  'workspace.terminal.new': 'Nieuwe terminal',
  'workspace.terminal.resize': 'Sleep om het formaat te wijzigen',
  'workspace.terminal.scrollBottom': 'Naar beneden scrollen',
  'workspace.terminal.shellOnly': 'Alleen shell',
} as const satisfies CatalogOf<MessageKey>;

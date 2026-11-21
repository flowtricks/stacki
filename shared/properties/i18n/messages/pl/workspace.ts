// Polish `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Zamknij (zmiany są zapisywane na bieżąco)',
  'workspace.code.title': 'Kod',
  'workspace.notifications.dismiss': 'Zamknij powiadomienie',
  'workspace.notifications.label': 'Powiadomienia',
  'workspace.notifications.loadMore': 'Wczytaj więcej ({count})',
  'workspace.notifications.showFewer': 'Pokaż mniej',
  'workspace.terminal.close': 'Zamknij terminal',
  'workspace.terminal.custom': 'Własne…',
  'workspace.terminal.customPlaceholder': 'np. bun run watch',
  'workspace.terminal.customTitle': 'Uruchom raz w każdym nowym terminalu',
  'workspace.terminal.hide': 'Ukryj terminal ({shortcut})',
  'workspace.terminal.loading': 'Wczytywanie terminala',
  'workspace.terminal.new': 'Nowy terminal',
  'workspace.terminal.resize': 'Przeciągnij, aby zmienić rozmiar',
  'workspace.terminal.scrollBottom': 'Przewiń na dół',
  'workspace.terminal.shellOnly': 'Tylko powłoka',
} as const satisfies CatalogOf<MessageKey>;

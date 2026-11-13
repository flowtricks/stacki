// French `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Fermer (les modifications sont enregistrées en direct)',
  'workspace.code.title': 'Code', // same
  'workspace.notifications.dismiss': 'Ignorer la notification',
  'workspace.notifications.label': 'Notifications', // same
  'workspace.notifications.loadMore': 'Charger plus ({count})',
  'workspace.notifications.showFewer': 'Afficher moins',
  'workspace.terminal.close': 'Fermer le terminal',
  'workspace.terminal.custom': 'Personnalisé…',
  'workspace.terminal.customPlaceholder': 'p. ex. bun run watch',
  'workspace.terminal.customTitle': 'Exécuté une fois dans chaque nouveau terminal',
  'workspace.terminal.hide': 'Masquer le terminal ({shortcut})',
  'workspace.terminal.loading': 'Chargement du terminal',
  'workspace.terminal.new': 'Nouveau terminal',
  'workspace.terminal.resize': 'Faites glisser pour redimensionner',
  'workspace.terminal.scrollBottom': 'Aller en bas',
  'workspace.terminal.shellOnly': 'Shell uniquement',
} as const satisfies CatalogOf<MessageKey>;

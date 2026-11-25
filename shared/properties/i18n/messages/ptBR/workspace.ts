// Brazilian Portuguese `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Fechar (as edições são salvas na hora)',
  'workspace.code.title': 'Código',
  'workspace.notifications.dismiss': 'Dispensar notificação',
  'workspace.notifications.label': 'Notificações',
  'workspace.notifications.loadMore': 'Carregar mais ({count})',
  'workspace.notifications.showFewer': 'Mostrar menos',
  'workspace.terminal.close': 'Fechar terminal',
  'workspace.terminal.custom': 'Personalizado…',
  'workspace.terminal.customPlaceholder': 'ex.: bun run watch',
  'workspace.terminal.customTitle': 'Executado uma vez em cada novo terminal',
  'workspace.terminal.hide': 'Ocultar terminal ({shortcut})',
  'workspace.terminal.loading': 'Carregando terminal',
  'workspace.terminal.new': 'Novo terminal',
  'workspace.terminal.resize': 'Arraste para redimensionar',
  'workspace.terminal.scrollBottom': 'Rolar até o fim',
  'workspace.terminal.shellOnly': 'Somente shell', // review
} as const satisfies CatalogOf<MessageKey>;

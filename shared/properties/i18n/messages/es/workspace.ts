// Spanish `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Cerrar (los cambios se guardan al instante)',
  'workspace.code.title': 'Código',
  'workspace.notifications.dismiss': 'Descartar notificación',
  'workspace.notifications.label': 'Notificaciones',
  'workspace.notifications.loadMore': 'Cargar más ({count})',
  'workspace.notifications.showFewer': 'Mostrar menos',
  'workspace.terminal.close': 'Cerrar terminal',
  'workspace.terminal.custom': 'Personalizado…',
  'workspace.terminal.customPlaceholder': 'p. ej. bun run watch',
  'workspace.terminal.customTitle': 'Se ejecuta una vez en cada terminal nueva',
  'workspace.terminal.hide': 'Ocultar terminal ({shortcut})',
  'workspace.terminal.loading': 'Cargando terminal',
  'workspace.terminal.new': 'Nueva terminal',
  'workspace.terminal.resize': 'Arrastra para cambiar el tamaño',
  'workspace.terminal.scrollBottom': 'Ir al final',
  'workspace.terminal.shellOnly': 'Solo shell', // review
} as const satisfies CatalogOf<MessageKey>;

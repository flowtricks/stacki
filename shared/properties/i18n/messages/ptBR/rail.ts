// Brazilian Portuguese `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat de IA',
  'rail.appWaiting': '{name}: {count} aguardando',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Recursos',
  'rail.audits': 'Auditorias',
  'rail.cms': 'CMS', // same
  'rail.code': 'Código',
  'rail.collections': 'Coleções',
  'rail.components': 'Componentes',
  'rail.editorPanels': 'Painéis do editor',
  'rail.history': 'Git', // same
  'rail.more': 'Mais',
  'rail.moveToBottom': 'Mover para o grupo inferior',
  'rail.moveToTop': 'Mover para o grupo superior',
  'rail.movedBottom': '{label}: grupo inferior, posição {position} de {count}',
  'rail.movedTop': '{label}: grupo superior, posição {position} de {count}',
  'rail.navigator': 'Navegador',
  'rail.orderMenu': 'Ordem da barra',
  'rail.pages': 'Páginas',
  'rail.properties': 'Propriedades',
  'rail.reset': 'Redefinir a ordem da barra',
  'rail.resetDone': 'Ordem da barra redefinida',
  'rail.selectors': 'Seletores de estilo',
  'rail.settings': 'Configurações',
  'rail.variables': 'Variáveis',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

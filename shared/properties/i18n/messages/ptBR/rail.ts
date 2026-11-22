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
  'rail.elements': 'Adicionar elementos',
  'rail.history': 'Git', // same
  'rail.more': 'Mais',
  'rail.moveDown': 'Mover para baixo',
  'rail.moveIntoSettings': 'Mover para Configurações',
  'rail.moveToBottom': 'Mover para o grupo inferior',
  'rail.moveToRail': 'Mover para a barra lateral',
  'rail.moveToTop': 'Mover para o grupo superior',
  'rail.moveUp': 'Mover para cima',
  'rail.movedBottom': '{label}: grupo inferior, posição {position} de {count}',
  'rail.movedSettings': '{label}: Configurações, posição {position} de {count}',
  'rail.movedTop': '{label}: grupo superior, posição {position} de {count}',
  'rail.navigator': 'Navegador',
  'rail.orderMenu': 'Ordem da barra',
  'rail.pages': 'Páginas',
  'rail.properties': 'Propriedades',
  'rail.reset': 'Redefinir a ordem da barra',
  'rail.resetDone': 'Ordem da barra redefinida',
  'rail.selectors': 'Seletores de estilo',
  'rail.settings': 'Configurações',
  'rail.settingsEmpty': 'Arraste ícones da barra lateral para cá para mantê-los em Configurações',
  'rail.settingsOrder.description': 'Arraste os ícones da barra lateral para reordená-los. Volte à ordem padrão.',
  'rail.settingsOrder.done': 'Ordem da barra lateral redefinida',
  'rail.settingsOrder.label': 'Ordem dos ícones da barra lateral',
  'rail.settingsOrder.reset': 'Redefinir para o padrão',
  'rail.variables': 'Variáveis',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

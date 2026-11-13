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
  'rail.instructions': 'Instruções',
  'rail.more': 'Mais',
  'rail.navigator': 'Navegador',
  'rail.pages': 'Páginas',
  'rail.properties': 'Propriedades',
  'rail.selectors': 'Seletores de estilo',
  'rail.settings': 'Configurações',
  'rail.variables': 'Variáveis',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

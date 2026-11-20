// Spanish `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat de IA',
  'rail.appWaiting': '{name}: {count} en espera',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Recursos',
  'rail.audits': 'Auditorías',
  'rail.cms': 'CMS', // same
  'rail.code': 'Código',
  'rail.collections': 'Colecciones',
  'rail.components': 'Componentes',
  'rail.editorPanels': 'Paneles del editor',
  'rail.history': 'Git', // same
  'rail.more': 'Más',
  'rail.moveToBottom': 'Mover al grupo inferior',
  'rail.moveToTop': 'Mover al grupo superior',
  'rail.movedBottom': '{label}: grupo inferior, posición {position} de {count}',
  'rail.movedTop': '{label}: grupo superior, posición {position} de {count}',
  'rail.navigator': 'Navegador',
  'rail.orderMenu': 'Orden de la barra',
  'rail.pages': 'Páginas',
  'rail.properties': 'Propiedades',
  'rail.reset': 'Restablecer el orden de la barra',
  'rail.resetDone': 'Orden de la barra restablecido',
  'rail.selectors': 'Selectores de estilo',
  'rail.settings': 'Ajustes',
  'rail.variables': 'Variables', // same
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

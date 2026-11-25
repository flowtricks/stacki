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
  'rail.elements': 'Añadir elementos',
  'rail.files': 'Archivos',
  'rail.history': 'Git', // same
  'rail.more': 'Más',
  'rail.moveDown': 'Mover hacia abajo',
  'rail.moveToRail': 'Mover a la barra lateral',
  'rail.moveUp': 'Mover hacia arriba',
  'rail.movedBottom': '{label}: grupo inferior, posición {position} de {count}',
  'rail.movedSettings': '{label}: Ajustes, posición {position} de {count}',
  'rail.movedTop': '{label}: grupo superior, posición {position} de {count}',
  'rail.navigator': 'Navegador',
  'rail.orderMenu': 'Orden de la barra',
  'rail.pages': 'Páginas',
  'rail.properties': 'Propiedades',
  'rail.selectors': 'Selectores de estilo',
  'rail.settings': 'Ajustes',
  'rail.settingsEmpty': 'Arrastra aquí los iconos de la barra lateral para mantenerlos en Ajustes',
  'rail.settingsOrder.description': 'Arrastra los iconos de la barra lateral para reordenarlos. Restablece el orden predeterminado.',
  'rail.settingsOrder.done': 'Orden de la barra lateral restablecido',
  'rail.settingsOrder.label': 'Orden de los iconos de la barra lateral',
  'rail.settingsOrder.reset': 'Restablecer a predeterminado',
  'rail.variables': 'Variables', // same
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

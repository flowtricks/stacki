// Spanish `structure` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/structure';

export const messages = {
  'structure.collapseAll': 'Contraer todo',
  'structure.dragHere': 'Arrastra componentes aquí',
  'structure.error.needsDeveloper': 'Esta página necesita que un desarrollador corrija su código fuente antes de editarla.',
  'structure.error.openCode': 'Abrir panel de código',
  'structure.error.syntax': 'Esta página contiene un error de sintaxis.',
  'structure.error.syntaxNear': '{message} Cerca de {near}',
  'structure.expandAll': 'Expandir todo',
  'structure.frontmatter': 'Frontmatter', // same
  'structure.imports': { one: '1 importación', other: '{count} importaciones' },
  'structure.menu.convertTo': 'Convertir en',
  'structure.menu.copy': 'Copiar',
  'structure.menu.cut': 'Cortar',
  'structure.menu.delete': 'Eliminar',
  'structure.menu.duplicate': 'Duplicar',
  'structure.menu.label': 'Acciones del elemento',
  'structure.menu.openComponent': 'Abrir componente',
  'structure.menu.paste': 'Pegar',
  'structure.menu.setDefaults': 'Definir valores por defecto del componente',
  'structure.menu.wrapIn': 'Envolver en',
  'structure.missing.injected':
    '{route} proviene de {from}, no de este proyecto: se puede previsualizar aquí, pero su marcado está en una dependencia y no es editable.',
  'structure.missing.integration': 'una integración',
  'structure.missing.select': 'Selecciona una página para editarla.',
  'structure.row.imported': 'Importado desde {file}',
  'structure.status.empty': 'No muestra nada en la página con sus props actuales',
  'structure.status.hidden': 'display: none — está en la página, pero no se dibuja',
  'structure.status.inert': 'pointer-events: none — se dibuja, pero no recibe clics',
} as const satisfies CatalogOf<MessageKey>;

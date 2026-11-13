// Spanish `history` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/history';

export const messages = {
  'history.backToNow': 'Volver al presente',
  'history.commit.actions': 'Acciones del commit',
  'history.commit.merge': 'Commit de fusión', // review
  'history.commit.preview': 'Vista previa',
  'history.commit.restoreProject': 'Restaurar el proyecto a este commit…', // review
  'history.commit.you': 'Tú',
  'history.day.today': 'Hoy',
  'history.day.yesterday': 'Ayer',
  'history.dialog.close': 'Cerrar archivos modificados',
  'history.dialog.title': 'Archivos modificados ({count})',
  'history.diff.allFiles': 'Todos los archivos',
  'history.diff.emptyTree': 'Árbol vacío', // review
  'history.diff.firstParent': 'comparado con el primer padre', // review
  'history.diff.label': 'Diferencias del archivo',
  'history.diff.loading': 'Cargando diferencias…',
  'history.diff.noTextChanges': 'No hay cambios de texto en este archivo.',
  'history.diff.restoreFile': 'Restaurar archivo…',
  'history.error.diffTooLarge': 'La diferencia de este archivo es demasiado grande para mostrarla.',
  'history.error.diffTooManyLines': 'La diferencia de este archivo tiene demasiadas líneas para mostrarla.',
  'history.error.diffUnreadable': 'No se pudo leer la diferencia de esta confirmación.',
  'history.files.added': {
    one: '{count} archivo añadido',
    other: '{count} archivos añadidos',
  },
  'history.files.changedLabel': 'archivos modificados',
  'history.files.count': {
    one: '{count} archivo',
    other: '{count} archivos',
  },
  'history.files.deleted': {
    one: '{count} archivo eliminado',
    other: '{count} archivos eliminados',
  },
  'history.files.from': 'Desde {path}',
  'history.files.listLabel': 'Lista de archivos modificados',
  'history.files.noMatch': 'Ningún archivo coincide con este filtro.',
  'history.files.none': 'No se modificó ningún archivo.',
  'history.files.unavailable': 'Los archivos modificados no están disponibles para este commit.',
  'history.files.updated': {
    one: '{count} archivo actualizado',
    other: '{count} archivos actualizados',
  },
  'history.files.view': 'Ver archivos modificados ({count})',
  'history.files.viewDiff': 'Ver diferencias de {path}',
  'history.filter.added': 'Nuevos',
  'history.filter.all': 'Todos',
  'history.filter.deleted': 'Eliminados',
  'history.filter.label': 'Filtrar archivos modificados',
  'history.filter.updated': 'Modificados',
  'history.scope.all': 'Todas las ramas',
  'history.scope.ariaLabel': 'Filtrar commits por rama',
  'history.scope.current': 'Rama actual',
  'history.scope.label': 'Filtrar commits',
  'history.scope.showing': 'Mostrando commits de {branch}',
  'history.sort.ariaLabel': 'Ordenar archivos modificados',
  'history.sort.label': 'Ordenar',
  'history.sort.path': 'Ruta del archivo',
  'history.sort.status': 'Estado',
  'history.summary.moreFiles': {
    one: '{first} y {count} archivo más',
    other: '{first} y {count} archivos más',
  },
  'history.summary.morePages': {
    one: '{first} y {count} página más',
    other: '{first} y {count} páginas más',
  },
  'history.summary.none': 'No se modificó ningún archivo',
  'history.summary.two': '{first} y {second}',
  'history.time.daysAgo': {
    one: 'hace {count} día',
    other: 'hace {count} días',
  },
  'history.time.hoursAgo': {
    one: 'hace {count} hora',
    other: 'hace {count} horas',
  },
  'history.time.justNow': 'ahora mismo',
  'history.time.minutesAgo': {
    one: 'hace {count} minuto',
    other: 'hace {count} minutos',
  },
  'history.time.yesterday': 'ayer',
  'history.timeline.empty': 'Aún no hay nada guardado. Cuando guardes tu primera versión aparecerá aquí y podrás volver a ella cuando quieras.',
  'history.timeline.label': 'Historial de Git',
  'history.timeline.showOlder': 'Mostrar anteriores',
  'history.versionHistory': 'Historial de versiones',
} as const satisfies CatalogOf<MessageKey>;

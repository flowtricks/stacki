// Spanish `variables` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/variables';

export const messages = {
  'variables.cell.chooseColor': 'Elige el color de {name}',
  'variables.cell.editCurve': 'Editar la curva de {name}',
  'variables.count': { one: '1 variable', other: '{count} variables' }, // same
  'variables.dragToReorder': 'Arrastra para reordenar',
  'variables.error.add': 'No se pudo añadir.',
  'variables.error.alreadyDeclared': '{name} ya está declarada en {selector}.',
  'variables.error.alreadyExists': '{name} ya existe.',
  'variables.error.badVariableName': '«{name}» no puede ser el nombre de una variable.',
  'variables.error.changedSincePanelRead': 'Este archivo cambió desde que el panel lo leyó.',
  'variables.error.collaboratorChanged': 'Un colaborador cambió este código fuente. Actualiza e inténtalo de nuevo.',
  'variables.error.delete': 'No se pudo eliminar.',
  'variables.error.duplicate': 'No se pudo duplicar.',
  'variables.error.headingCannotContainCommentEnd': 'Un encabezado no puede contener "*/".',
  'variables.error.headingNeedsName': 'Un encabezado necesita un nombre.',
  'variables.error.headingNotComment': 'Ese encabezado ya no es un comentario.',
  'variables.error.move': 'No se pudo mover.',
  'variables.error.notDeclared': '{name} ya no está declarada ahí.',
  'variables.error.notVariableName': '{name} no es un nombre de variable.',
  'variables.error.nothingToHead': '{selector} no tiene nada que encabezar.', // review
  'variables.error.outsideStyleBlock': 'Eso cambiaría el archivo fuera de su bloque {tag}, así que no se guardó.',
  'variables.error.parse': 'No se pudo analizar — {detail}',
  'variables.error.placeGone': 'Ese lugar ya no está en el archivo.',
  'variables.error.prefixHeading': 'Este encabezado es un prefijo de nombre, no un comentario CSS.',
  'variables.error.rename': 'No se pudo renombrar.',
  'variables.error.renamedTwice': '{name} se renombra dos veces a la vez.',
  'variables.error.restart': 'Hay que reiniciar Stacki antes de poder usar esto.',
  'variables.error.restoreRename': 'No se pudo restaurar el cambio de nombre.',
  'variables.error.restoreStylesheet': 'No se pudo restaurar esa hoja de estilo.',
  'variables.error.ruleGone': '{selector} ya no está en {file}.',
  'variables.error.ruleInSeveralBlocks': '{selector} está en más de un bloque {tag} de {file}. Edita este en el código.',
  'variables.error.sameNameTwice': 'Dos variables se llamarían {name}.',
  'variables.error.styleBlockLine': 'El bloque {tag} de la línea {line}: {detail}',
  'variables.error.variablesNotDeclared': 'Esas variables ya no están declaradas ahí.',
  'variables.error.write': 'No se pudo escribir ese valor.',
  'variables.fluid.error':
    'No llega al doble de su tamaño original con un zoom del 500 %. Reduce la diferencia entre el tamaño máximo y mínimo de la variable.',
  'variables.fluid.labelError': 'Error de accesibilidad: {message}',
  'variables.fluid.labelWarning': 'Aviso de accesibilidad: {message}',
  'variables.fluid.readWhy': 'Leer por qué',
  'variables.fluid.warning': 'Se reduce al aumentar el zoom. Aumenta la diferencia entre el tamaño máximo y mínimo del viewport.',
  'variables.group.options': 'Opciones del grupo',
  'variables.head.name': 'Nombre',
  'variables.head.value': 'Valor',
  'variables.menu.delete': 'Eliminar',
  'variables.menu.duplicate': 'Duplicar',
  'variables.menu.rename': 'Renombrar',
  'variables.modes': { one: '1 modo', other: '{count} modos' },
  'variables.name.clickToRename': 'Haz clic para renombrar',
  'variables.name.dragOrRename': '{name}: arrastra para mover, haz clic para renombrar',
  'variables.new': 'Nueva variable',
  'variables.noMatches': 'Nada coincide con la búsqueda.',
  'variables.panel.allFiles': 'Todos los archivos',
  'variables.panel.cssVariables': 'variables CSS',
  'variables.panel.empty': 'No se encontraron propiedades personalizadas de CSS en las hojas de estilo ni en las etiquetas {tag} de este proyecto.',
  'variables.saved': 'Guardado',
  'variables.scope.page': 'Esta página',
  'variables.scope.pageDetail': 'Declarada en un {tag} de esta página, así que solo se aplica en esta página.',
  'variables.scope.rendered': 'Donde se renderiza',
  'variables.scope.renderedDetail': 'Declarada en un {tag} de este archivo, así que solo se aplica en las páginas que lo renderizan.',
  'variables.scope.scoped': 'Solo este archivo',
  'variables.scope.scopedDetail': 'Astro limita el alcance de este {tag}, así que esta regla solo afecta a los elementos escritos en este archivo.',
  'variables.scope.writtenGlobal': 'El bloque es is:global: Astro lo empaqueta sin limitar su alcance.',
  'variables.scope.writtenInline': 'El bloque es is:inline: Astro lo deja en la página exactamente como está escrito.',
  'variables.scope.writtenScoped': 'El bloque es un {tag} normal: :root, html, body y :global() no se limitan; el resto de selectores sí.',
  'variables.scroll.label': 'Desplazar los valores de las variables horizontalmente',
  'variables.search': 'Buscar variables',
  'variables.title': 'Variables', // same
  'variables.type.color': 'Color',
  'variables.type.number': 'Número',
  'variables.type.size': 'Tamaño',
  'variables.type.text': 'Texto',
  'variables.undo.deleteGroup': 'la eliminación del grupo', // review
  'variables.undo.group': 'el grupo', // review
  'variables.undo.groupRename': 'el cambio de nombre del grupo', // review
  'variables.undo.heading': 'el encabezado', // review
  'variables.undo.move': 'el movimiento', // review
  'variables.undo.rename': 'el cambio de nombre', // review
  'variables.undo.value': 'el valor', // review
  'variables.undo.variable': 'la variable', // review
} as const satisfies CatalogOf<MessageKey>;

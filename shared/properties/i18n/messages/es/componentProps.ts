// Spanish `componentProps` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentProps';

export const messages = {
  'componentProps.attributes.addDefault': 'Añadir atributo predeterminado',
  'componentProps.attributes.connections': 'Conexiones',
  'componentProps.attributes.connectionsCount': { one: 'Conexiones: {count} elemento', other: 'Conexiones: {count} elementos' },
  'componentProps.attributes.defaultName': 'Nombre del atributo predeterminado {number}',
  'componentProps.attributes.defaultValue': 'Valor del atributo predeterminado {number}',
  'componentProps.attributes.defaults': 'Atributos predeterminados',
  'componentProps.attributes.defaultsDiffer': 'Los elementos conectados tienen valores predeterminados distintos; si editas uno, todos reciben estos.',
  'componentProps.attributes.name': 'Nombre',
  'componentProps.attributes.namePlaceholder': 'nombre',
  'componentProps.attributes.noSpread': 'Ningún elemento expande {spread} todavía. Conecta uno desde el punto de enlace de sus atributos.', // review
  'componentProps.attributes.passThrough': 'Pasa el resto de atributos mediante {spread}.',
  'componentProps.attributes.removeDefault': 'Quitar atributo predeterminado {name}',
  'componentProps.attributes.rowKind': { one: 'Atributos · {count} elemento', other: 'Atributos · {count} elementos' },
  'componentProps.attributes.select': 'Seleccionar {name}',
  'componentProps.attributes.title': 'Propiedad de atributos',
  'componentProps.attributes.tooltipDefault': 'Atributos que una instancia añade a los elementos conectados',
  'componentProps.attributes.valuePlaceholder': 'valor',
  'componentProps.autosave.conflict': 'Este archivo cambió en el disco, así que el formulario se recargó. Tu edición se conservó.',
  'componentProps.declaration.default': 'Predeterminado (línea {line}): {expression}',
  'componentProps.declaration.details': 'Detalles de la declaración',
  'componentProps.declaration.source': '{label} (línea {line}): {expression}',
  'componentProps.declaration.variantRules': 'Reglas de variantes',
  'componentProps.default.none': 'Sin valor predeterminado',
  'componentProps.default.number': 'Número predeterminado',
  'componentProps.default.search': 'Buscar valores…',
  'componentProps.default.text': 'Texto predeterminado',
  'componentProps.default.useControl': 'Usar el control de valor predeterminado',
  'componentProps.default.value': 'Valor predeterminado',
  'componentProps.default.writeExpression': 'Escribir una expresión predeterminada',
  'componentProps.defaults.discard': 'Descartar cambios',
  'componentProps.defaults.return': 'Volver a los valores predeterminados',
  'componentProps.defaults.saveFailed': 'No se pudieron guardar los valores predeterminados del componente.',
  'componentProps.defaults.saved': 'Valores predeterminados guardados en este proyecto.',
  'componentProps.dialog.close': 'Cerrar ajustes de la propiedad',
  'componentProps.dialog.loading': 'Cargando propiedad…',
  'componentProps.dialog.title': 'Ajustes de la propiedad',
  'componentProps.editor.delete': 'Eliminar propiedad',
  'componentProps.editor.deleteNamed': 'Eliminar {name}',
  'componentProps.editor.name': 'Nombre',
  'componentProps.editor.newProperty': 'Propiedad nueva',
  'componentProps.editor.renameHelp':
    'Al renombrar se actualiza la propiedad de este componente, la variable que la lee y sus instancias en todo el sitio web.',
  'componentProps.editor.renameShared': 'Al renombrar se reescribe {typeName} y cada lectura de ella, en estos archivos:', // review
  'componentProps.kind.attributes': 'Atributos',
  'componentProps.kind.choice': 'Opción',
  'componentProps.kind.code': 'Tipo de código…',
  'componentProps.kind.color': 'Color', // same
  'componentProps.kind.curated': 'Elementos elegidos',
  'componentProps.kind.date': 'Fecha',
  'componentProps.kind.filter': 'Filtro',
  'componentProps.kind.group': 'Grupo',
  'componentProps.kind.image': 'Imagen',
  'componentProps.kind.link': 'Enlace',
  'componentProps.kind.list': 'Lista',
  'componentProps.kind.number': 'Número',
  'componentProps.kind.record': 'Lista clave–valor',
  'componentProps.kind.sort': 'Orden',
  'componentProps.kind.switch': 'Interruptor',
  'componentProps.kind.text': 'Texto',
  'componentProps.kindHint.attributes': 'Desde los atributos de un elemento',
  'componentProps.kindHint.choice': 'Una de una lista',
  'componentProps.kindHint.code': 'Escribir un tipo de TypeScript',
  'componentProps.kindHint.curated': 'Elecciones de la lista de colección',
  'componentProps.kindHint.filter': 'Filtros de la lista de colección',
  'componentProps.kindHint.group': 'Campos de un objeto',
  'componentProps.kindHint.list': 'Elementos con campos',
  'componentProps.kindHint.sort': 'Orden de la lista de colección',
  'componentProps.kindSection.advanced': 'Avanzado',
  'componentProps.kindSection.basic': 'Básico',
  'componentProps.kindSection.collection': 'Lista de colección',
  'componentProps.kindSection.element': 'Elemento',
  'componentProps.kindSection.media': 'Medios y enlaces',
  'componentProps.kindSection.structure': 'Estructura',
  'componentProps.options.title': 'Opciones',
  'componentProps.panel.add': 'Añadir propiedad',
  'componentProps.panel.deletedIn': '{name} se elimina en {path}',
  'componentProps.panel.empty': 'Aún no hay propiedades. Añade una para definir qué puede personalizar cada instancia.',
  'componentProps.panel.from': 'De {typeName}',
  'componentProps.panel.label': 'Propiedades del componente',
  'componentProps.panel.loading': 'Cargando propiedades…',
  'componentProps.panel.openFile': 'Abrir {path}',
  'componentProps.panel.propertyGone': 'Este componente ya no tiene una propiedad {name}.',
  'componentProps.panel.required': 'Obligatoria',
  'componentProps.panel.saveBusy': 'Todavía se está ejecutando otro guardado. Inténtalo de nuevo.',
  'componentProps.panel.title': 'Propiedades',
  'componentProps.panel.unused': 'No se usa en este componente',
  'componentProps.problem.decimalsRange': 'Los decimales van de 0 a {max}.',
  'componentProps.problem.decimalsWhole': 'Los decimales son un número entero.',
  'componentProps.problem.minAboveMax': 'El mínimo es mayor que el máximo.',
  'componentProps.problem.nameShape': 'Usa un nombre como title, imageUrl o isVisible.',
  'componentProps.problem.typeMissing': 'Asigna un tipo a la propiedad.',
  'componentProps.reorder.hint': 'Arrastra para reordenar (o usa las flechas)',
  'componentProps.reorder.label': 'Reordenar {name}',
  'componentProps.settings.auto': 'Auto', // same
  'componentProps.settings.decimals': 'Decimales',
  'componentProps.settings.decimalsHint': 'Cuántos decimales conserva el número: 0 es un entero, como máximo {max}.',
  'componentProps.settings.defaultNote': 'El valor predeterminado: {note}',
  'componentProps.settings.legacyRemove': { one: 'Quitarla', other: 'Quitarlas' },
  'componentProps.settings.legacyTags': {
    one: 'Este documento tiene una etiqueta de interruptor sin usar que nada lee.',
    other: 'Este documento tiene etiquetas de interruptor sin usar que nada lee.',
  }, // review
  'componentProps.settings.max': 'Máx.',
  'componentProps.settings.min': 'Mín.',
  'componentProps.settings.none': 'Ninguno',
  'componentProps.settings.numberGroup': 'Ajustes del número',
  'componentProps.settings.numberMalformed': 'Escribe un número o déjalo vacío para ninguno.',
  'componentProps.settings.tooltip': 'Información emergente',
  'componentProps.settings.tooltipPlaceholder': 'Describe cómo usar esta propiedad…',
  'componentProps.share.components': 'Componentes',
  'componentProps.share.declaredIn': 'Declarada en',
  'componentProps.share.defaults': 'Valores predeterminados',
  'componentProps.share.instancesIn': 'Instancias en',
  'componentProps.share.summary': {
    one: 'Compartida: edita {typeName} en {path}, usada por {count} componente ({names}) y sus instancias.',
    other: 'Compartida: edita {typeName} en {path}, usada por {count} componentes ({names}) y sus instancias.',
  }, // review
  'componentProps.type.attributesNote': 'Una propiedad de atributos se crea desde un elemento: abre el punto de enlace de sus atributos.',
  'componentProps.type.codeType': 'Tipo de código',
  'componentProps.type.defaultCleared': 'Se borró el valor predeterminado: no encaja con «{kind}».',
  'componentProps.type.kind': 'Tipo', // review
  'componentProps.type.noType': 'Sin tipo',
  'componentProps.type.search': 'Buscar tipos…', // review
  'componentProps.type.typescript': 'TypeScript', // same
  'componentProps.variants.addCondition': 'Añadir condición', // review
  'componentProps.variants.and': 'y', // review
  'componentProps.variants.badIndex': 'Esa posición está fuera de las opciones.', // review
  'componentProps.variants.badValue': 'Usa un nombre corto sin comillas ni barras invertidas.', // review
  'componentProps.variants.booleanOptions': '{name} es true o false: sus dos opciones no se pueden añadir, renombrar ni eliminar.', // review
  'componentProps.variants.cannotAttach':
    '{name} no está declarada en las propiedades que comparten todas las opciones, así que aquí no puede tener reglas de variante.', // review
  'componentProps.variants.cannotGroup': 'Props no está escrito como un tipo al que Stacki pueda añadir reglas de variante.', // review
  'componentProps.variants.cell': '{prop} cuando {controller} es {value}', // review
  'componentProps.variants.condition': '{controller}: {options}', // same
  'componentProps.variants.conditional': 'Condicional', // review
  'componentProps.variants.controlledBy': 'Controlado por', // review
  'componentProps.variants.duplicateOption': 'Ya existe una opción {value}.', // review
  'componentProps.variants.lastOptions': 'Conserva al menos dos opciones.', // review
  'componentProps.variants.missingGroup': 'Ninguna regla de variante está controlada por {name}.', // review
  'componentProps.variants.missingOption': 'No existe la opción {value}.', // review
  'componentProps.variants.missingProp': '{name} no forma parte de estas reglas de variante.', // review
  'componentProps.variants.noDestructure': 'El componente no lee sus propiedades con una sola desestructuración, así que la propiedad no se puede añadir aquí.', // review
  'componentProps.variants.noRuntimeType': 'El tipo de ejecución del componente no admite aquí una propiedad nueva.', // review
  'componentProps.variants.noType': '{name} no tiene un tipo que permitir. Dale primero un tipo.', // review
  'componentProps.variants.none': 'Ninguno', // review
  'componentProps.variants.optionInCode': 'El código del componente usa {value} de una forma que Stacki no puede actualizar. Cámbialo en el código fuente.', // review
  'componentProps.variants.optionPassed': '{file} pasa {value} como {name}. Cambia antes esa instancia.', // review
  'componentProps.variants.optionsLimit': 'Una propiedad puede tener como máximo {max} opciones.', // review
  'componentProps.variants.readOnly': 'Las reglas de variante controladas por {name} solo se pueden cambiar en el código fuente.', // review
  'componentProps.variants.reason.nested': 'Anidado', // review
  'componentProps.variants.reason.runtime': 'Ejecución', // review
  'componentProps.variants.reason.shape': 'Complejo', // review
  'componentProps.variants.reason.shared': 'Compartido', // review
  'componentProps.variants.removeCondition': 'Quitar {controller}', // review
  'componentProps.variants.removeFallback': '{value} es la predeterminada. Haz antes predeterminada otra opción.', // review
  'componentProps.variants.rules': 'Reglas', // review
  'componentProps.variants.state.forbidden': 'No permitido', // review
  'componentProps.variants.state.optional': 'Permitido', // review
  'componentProps.variants.state.required': 'Obligatorio', // review
} as const satisfies CatalogOf<MessageKey>;

// Spanish `cmsBackend` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/cmsBackend';

export const messages = {
  'cmsBackend.body.description': 'El Markdown de la entrada, debajo del frontmatter.',
  'cmsBackend.body.title': 'Cuerpo',
  'cmsBackend.config.collectionExists': 'Ya existe una colección llamada «{name}».',
  'cmsBackend.config.collectionsNotClosed': 'La exportación collections de la configuración de contenido no está cerrada.',
  'cmsBackend.config.nameUsed': '«{name}» ya se usa en la configuración de contenido.',
  'cmsBackend.config.noCollections': 'Stacki no encontró `export const collections = {{ … }}` en la configuración de contenido.',
  'cmsBackend.config.notListed': '{collection} no está en las colecciones de la configuración de contenido.',
  'cmsBackend.config.tooLarge': 'La configuración de contenido es demasiado grande para editarla aquí.',
  'cmsBackend.connection.cannotTest': 'Esta conexión no se puede probar.',
  'cmsBackend.content.unreadable': 'No se pudo leer la colección de contenido.',
  'cmsBackend.data.parseFailed': '{file} no se pudo analizar — {detail}',
  'cmsBackend.data.readFailed': 'No se pudo leer {file} — {detail}',
  'cmsBackend.data.tooLarge': '{file} es demasiado grande para editarlo aquí.',
  'cmsBackend.data.unreadableFormat': 'Stacki aún no puede leer archivos de datos {extension}.',
  'cmsBackend.entries.customLoader':
    '{collection} la construye un loader de este proyecto; no se guarda en un archivo. Sus entradas se reconstruyen desde cero en cada sincronización, así que lo que escribas aquí se sobrescribiría.', // review
  'cmsBackend.entries.idsGenerated':
    '{collection} genera sus ids en el loader a partir de los campos de cada entrada. Los ids mostrados son las rutas de archivo, que no son lo que referencian otras colecciones.', // review
  'cmsBackend.entries.parserNote':
    '{collection} se analiza con una función de la configuración de contenido antes de que Astro la vea. Los campos que no están en el archivo los creó ese analizador: se muestran, pero editar uno aquí no tendría adónde ir.', // review
  'cmsBackend.entry.generated': '{collection} genera sus ids en su loader, así que el id no cambia al renombrar un archivo.', // review
  'cmsBackend.entry.noId': 'Nada en {file} indica cuál es el id de esta entrada.',
  'cmsBackend.entry.parsed': '{collection} se analiza con una función de la configuración de contenido, así que sus ids no están en el archivo.', // review
  'cmsBackend.fieldName.empty': 'Pon nombre al campo.',
  'cmsBackend.fieldName.invalid': 'El nombre de un campo empieza con una letra y contiene letras, dígitos, - y _.',
  'cmsBackend.fieldName.tooLong': {
    one: 'El nombre de un campo tiene como máximo {count} carácter.',
    other: 'El nombre de un campo tiene como máximo {count} caracteres.',
  },
  'cmsBackend.media.bodyNotBytes': 'El host envió un cuerpo que no son bytes.',
  'cmsBackend.media.bodyTooLarge': 'El host envió más de {size} MB.',
  'cmsBackend.media.bunnyNoZone': 'Esta cuenta de Bunny no tiene ninguna storage zone llamada {name}.',
  'cmsBackend.media.bunnyNotList': 'Bunny Storage envió un listado que no es una lista.',
  'cmsBackend.media.bunnyRefusedKey':
    'Bunny rechazó esta clave de API. Usa la clave de API de la cuenta (Account settings → API key), no la contraseña de una storage zone.',
  'cmsBackend.media.bunnyUnreadable': 'Bunny Storage envió un listado ilegible.',
  'cmsBackend.media.cloudflareInactive': 'Este token de Cloudflare no está activo. Crea uno nuevo y vuelve a pegarlo.',
  'cmsBackend.media.cloudflareNoToken': 'Cloudflare no indicó de qué token se trata.',
  'cmsBackend.media.cloudflareRefused': 'Cloudflare rechazó la solicitud.{detail}',
  'cmsBackend.media.fileGone': 'Ese archivo ya no está.',
  'cmsBackend.media.fileTooLarge': '{name} supera {size} MB.',
  'cmsBackend.media.missingInFolder': '{name} ya no está en esta carpeta. Actualiza e inténtalo de nuevo.',
  'cmsBackend.media.nameExists': 'Ya existe algo con ese nombre.',
  'cmsBackend.media.nestedTooDeep': 'Esta carpeta está demasiado anidada para cambiarla aquí.',
  'cmsBackend.media.status.limited': 'El host está limitando las solicitudes. Inténtalo de nuevo en un momento.{detail}',
  'cmsBackend.media.status.notFound': 'El host no tiene ese bucket, zona o archivo.{detail}',
  'cmsBackend.media.status.refused': 'El host rechazó la solicitud ({status}).{detail}',
  'cmsBackend.media.status.refusedKeys': 'El host rechazó las claves. Revísalas y que puedan leer y escribir en este bucket.{detail}', // review
  'cmsBackend.media.status.server': 'El host tuvo un problema ({status}). Inténtalo de nuevo en un momento.{detail}',
  'cmsBackend.media.tooManyFiles': 'Esta carpeta tiene más de {count} archivos; cámbiala en el panel del propio host.',
  'cmsBackend.media.tooManyFilesBunny': 'Esta carpeta tiene más de {count} archivos; cámbiala en el panel de Bunny.',
  'cmsBackend.media.unreachable': 'No se pudo conectar con {host}: {reason}',
  'cmsBackend.network.failed': 'La solicitud al CMS falló.',
  'cmsBackend.payload.noDrafts': '{collection} no tiene borradores que publicar o descartar.',
  'cmsBackend.payload.noUpload': 'Payload no tiene ninguna colección de subidas visible para esta cuenta.',
  'cmsBackend.payload.notOrdered': 'Las colecciones de Payload no tienen orden.',
  'cmsBackend.sample.answered': 'Esa dirección respondió {status}.',
  'cmsBackend.sample.answeredWith': 'Esa dirección respondió {status}: {detail}',
  'cmsBackend.sample.notFound': 'No se encontró nada en esa dirección (404).',
  'cmsBackend.sample.refused': 'Esa dirección rechazó la solicitud ({status}). Revisa el encabezado y su valor.',
  'cmsBackend.sample.tooLarge': 'Esa respuesta supera {size} MB, demasiado para tomar una muestra.',
  'cmsBackend.sanity.answered': 'Sanity respondió {status}.',
  'cmsBackend.sanity.noKeyRole':
    'Tu rol en este proyecto de Sanity no puede crear claves de API (sí pueden Administrador o Desarrollador). Pídele una a un administrador y pégala con la opción de clave junto al botón de inicio de sesión.', // review
  'cmsBackend.sanity.signInFailed': 'Falló el inicio de sesión en Sanity.',
  'cmsBackend.sanity.signInGone': 'Este inicio de sesión de Sanity ya no está en curso.',
  'cmsBackend.sanity.signInTimedOut': 'Se agotó el tiempo del inicio de sesión en Sanity.',
  'cmsBackend.sanity.someone': 'Alguien',
  'cmsBackend.schema.collectionExists': 'Ya existe una colección llamada {name}.',
  'cmsBackend.schema.fieldExists': 'Ya existe un campo llamado {name}.',
  'cmsBackend.schema.fieldsChanged': 'Los campos cambiaron desde que se listaron. Vuelve a abrir los ajustes.',
  'cmsBackend.schema.imageByHand': 'Añade `image` a mano a la función del esquema y luego añade el campo.',
  'cmsBackend.schema.noField': 'No hay ningún campo {name}.',
  'cmsBackend.schema.noImageSchema': 'Esta colección no tiene un esquema al que añadir un campo de imagen.',
  'cmsBackend.schema.noObject': '{collection} no tiene en la configuración ningún esquema z.object({{ … }}) que editar.',
  'cmsBackend.schema.notCollection': '{name} no es una colección de la configuración de contenido.',
  'cmsBackend.schema.tooComplex': '{name} está escrito como método o como una cadena muy larga; edítalo en la configuración.',
  'cmsBackend.slug.empty': 'Un slug necesita al menos una letra o un número',
  'cmsBackend.slug.saved': 'Se guarda como «{slug}»',
  'cmsBackend.slug.taken': 'Otro elemento ya usa este slug',
  'cmsBackend.slug.tooLong': { one: 'Máximo {count} carácter', other: 'Máximo {count} caracteres' },
} as const satisfies CatalogOf<MessageKey>;

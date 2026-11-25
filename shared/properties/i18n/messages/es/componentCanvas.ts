// Spanish `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Cierra el editor de valores predeterminados antes de abrir un lienzo.',
  'componentCanvas.error.notOpened': 'El componente no se abrió en el lienzo. Vuelve a intentarlo.',
  'componentCanvas.error.notReturned': 'No se pudo volver al archivo en el que estabas. Ábrelo desde el panel Páginas.',
  'componentCanvas.error.open': 'No se pudo abrir el lienzo: {message}',
  'componentCanvas.error.save': 'No se pudieron guardar los ajustes del lienzo: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'sin definir',
  'componentCanvas.menu.open': 'Abrir lienzo',
  'componentCanvas.notice.truncated': 'Se muestran los primeros {shown} de {total} marcos. Da marcos propios a menos props para ver el resto.',
  'componentCanvas.pageName': 'Lienzo de {name}',
  'componentCanvas.panel.background': 'Fondo',
  'componentCanvas.panel.fixed': 'Fijo',
  'componentCanvas.panel.frame.hint':
    'Haz clic en la etiqueta de un marco o en el espacio alrededor de su componente para seleccionar el marco. Haz clic dentro del componente para editarlo.',
  'componentCanvas.panel.frame.pick': 'Marco',
  'componentCanvas.panel.frame.title': 'Marco',
  'componentCanvas.panel.frames': {
    one: '{count} marco',
    other: '{count} marcos',
  },
  'componentCanvas.panel.height': 'Alto',
  'componentCanvas.panel.hug': 'Al contenido',
  'componentCanvas.panel.pixels': '{side} en píxeles',
  'componentCanvas.panel.props.hint':
    'Los valores con los que se renderiza este marco. Se quedan en el lienzo y vuelven cada vez que lo abres. Nunca se escriben en el componente ni en sus instancias.',
  'componentCanvas.panel.props.none': 'No definido',
  'componentCanvas.panel.props.split': 'Cada valor de {name} tiene su propio marco.',
  'componentCanvas.panel.props.title': 'Props de vista previa',
  'componentCanvas.panel.props.unused': 'Esta variante no usa {name}.',
  'componentCanvas.panel.scope.all': 'Todos los marcos',
  'componentCanvas.panel.scope.frame': 'Este marco',
  'componentCanvas.panel.scope.hint':
    'Dónde se aplican el tamaño, el fondo y los valores de props que definas: en este marco, en todos los marcos de un valor o en todos los marcos. El ajuste propio de un marco prevalece sobre uno más amplio.',
  'componentCanvas.panel.scope.label': 'Aplicar a',
  'componentCanvas.panel.scope.part': 'Todos los marcos de {part}',
  'componentCanvas.panel.split.hint':
    'Cada valor de una prop activada aquí tiene su propio marco, y los marcos muestran todas las combinaciones. Una prop desactivada muestra un solo valor por marco, que defines en Props de vista previa.',
  'componentCanvas.panel.split.title': 'Marcos propios',
  'componentCanvas.panel.split.toggle': 'Dar a cada valor de {name} su propio marco',
  'componentCanvas.panel.transparent': 'Transparente',
  'componentCanvas.panel.values': {
    one: '{count} valor',
    other: '{count} valores',
  },
  'componentCanvas.panel.width': 'Ancho',
  'componentCanvas.titleBar.close': 'Cerrar el lienzo de {name}',
  'componentCanvas.zoom.fit': 'Ajustar',
  'componentCanvas.zoom.fitAll': 'Ajustar el zoom para ver todos los marcos',
  'componentCanvas.zoom.in': 'Acercar',
  'componentCanvas.zoom.out': 'Alejar',
  'componentCanvas.zoom.percent': '{percent} %',
  'componentCanvas.zoom.reset': 'Zoom al 100 %',
} as const satisfies CatalogOf<MessageKey>;

// Italian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Chiudi l’editor dei valori predefiniti prima di aprire un canvas.',
  'componentCanvas.error.notOpened': 'Il componente non si è aperto sul canvas. Riprova.',
  'componentCanvas.error.notReturned': 'Impossibile tornare al file in cui ti trovavi. Aprilo dal pannello Pagine.',
  'componentCanvas.error.open': 'Impossibile aprire il canvas: {message}',
  'componentCanvas.error.save': 'Impossibile salvare le impostazioni del canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'non impostato',
  'componentCanvas.menu.open': 'Apri canvas',
  'componentCanvas.notice.truncated': 'Vengono mostrati i primi {shown} frame su {total}. Assegna frame propri a meno props per vedere gli altri.',
  'componentCanvas.pageName': 'Canvas di {name}',
  'componentCanvas.panel.background': 'Sfondo',
  'componentCanvas.panel.fixed': 'Fisso',
  'componentCanvas.panel.frame.hint':
    'Fai clic sull’etichetta di un frame o sullo spazio intorno al suo componente per selezionare il frame. Fai clic dentro il componente per modificarlo.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frame',
  },
  'componentCanvas.panel.height': 'Altezza',
  'componentCanvas.panel.hug': 'Al contenuto',
  'componentCanvas.panel.pixels': '{side} in pixel',
  'componentCanvas.panel.props.hint':
    'I valori con cui viene renderizzato questo frame. Restano sul canvas e tornano ogni volta che lo apri. Non vengono mai scritti nel componente né nelle sue istanze.',
  'componentCanvas.panel.props.none': 'Non impostato',
  'componentCanvas.panel.props.split': 'Ogni valore di {name} ha il proprio frame.',
  'componentCanvas.panel.props.title': 'Props di anteprima',
  'componentCanvas.panel.props.unused': 'Questa variante non usa {name}.',
  'componentCanvas.panel.scope.all': 'Tutti i frame',
  'componentCanvas.panel.scope.frame': 'Questo frame',
  'componentCanvas.panel.scope.hint':
    'Dove si applicano la dimensione, lo sfondo e i valori delle props che imposti: a questo frame, a tutti i frame di un valore o a tutti i frame. L’impostazione propria di un frame prevale su una più ampia.',
  'componentCanvas.panel.scope.label': 'Applica a',
  'componentCanvas.panel.scope.part': 'Tutti i frame con {part}',
  'componentCanvas.panel.split.hint':
    'Ogni valore di una prop attivata qui ha il proprio frame, e i frame mostrano tutte le combinazioni. Una prop disattivata mostra un solo valore per frame, che imposti in Props di anteprima.',
  'componentCanvas.panel.split.title': 'Frame propri',
  'componentCanvas.panel.split.toggle': 'Assegna a ogni valore di {name} il proprio frame',
  'componentCanvas.panel.transparent': 'Trasparente',
  'componentCanvas.panel.values': {
    one: '{count} valore',
    other: '{count} valori',
  },
  'componentCanvas.panel.width': 'Larghezza',
  'componentCanvas.titleBar.close': 'Chiudi il canvas di {name}',
  'componentCanvas.zoom.fit': 'Adatta',
  'componentCanvas.zoom.fitAll': 'Adatta lo zoom a tutti i frame',
  'componentCanvas.zoom.in': 'Ingrandisci',
  'componentCanvas.zoom.out': 'Riduci',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom al 100%',
} as const satisfies CatalogOf<MessageKey>;

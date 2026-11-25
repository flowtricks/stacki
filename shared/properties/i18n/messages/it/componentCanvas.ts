// Italian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Chiudi l’editor dei valori predefiniti prima di aprire un canvas.',
  'componentCanvas.error.notOpened': 'Il componente non si è aperto sul canvas. Riprova.',
  'componentCanvas.error.notReturned': 'Impossibile tornare al file in cui ti trovavi. Aprilo dal pannello Pagine.',
  'componentCanvas.error.open': 'Impossibile aprire il canvas: {message}',
  'componentCanvas.error.pageReadOnly': 'Questo canvas mostra soltanto il componente. Fai doppio clic su un frame per modificare il componente al suo interno.',
  'componentCanvas.error.previewValue': 'Un frame può mostrare in anteprima testo, un numero o attivo e disattivo per {name}, non codice.',
  'componentCanvas.error.save': 'Impossibile salvare le impostazioni del canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'non impostato',
  'componentCanvas.framePanel.hide': 'Nascondi impostazioni del frame',
  'componentCanvas.framePanel.show': 'Mostra impostazioni del frame',
  'componentCanvas.menu.open': 'Apri nel canvas',
  'componentCanvas.notice.truncated': 'Vengono mostrati i primi {shown} frame su {total}. Assegna frame propri a meno props per vedere gli altri.',
  'componentCanvas.pageName': 'Canvas di {name}',
  'componentCanvas.panel.background': 'Sfondo',
  'componentCanvas.panel.backgroundVariable': 'Collega a variabile',
  'componentCanvas.panel.fixed': 'Fisso',
  'componentCanvas.panel.frame.about': 'Fai clic su un frame per selezionarne il componente e doppio clic per modificare il componente al suo interno.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frame',
  },
  'componentCanvas.panel.height': 'Altezza',
  'componentCanvas.panel.hug': 'Al contenuto',
  'componentCanvas.panel.pixels': '{side} in pixel',
  'componentCanvas.panel.scope.all': 'Tutti i frame',
  'componentCanvas.panel.scope.frame': 'Questo frame',
  'componentCanvas.panel.scope.hint':
    'Dove si applicano la dimensione, lo sfondo e i valori delle props che imposti: a questo frame, a tutti i frame di un valore o a tutti i frame. L’impostazione propria di un frame prevale su una più ampia.',
  'componentCanvas.panel.scope.label': 'Applica a',
  'componentCanvas.panel.scope.part': 'Tutti i frame con {part}',
  'componentCanvas.panel.scope.project': 'Tutti i componenti',
  'componentCanvas.panel.transparent': 'Trasparente',
  'componentCanvas.panel.width': 'Larghezza',
  'componentCanvas.popup.close': 'Chiudi impostazioni del frame',
  'componentCanvas.popup.title': 'Impostazioni del frame',
  'componentCanvas.split.full': 'Al massimo {max} props possono avere frame propri. Prima disattivane una.',
  'componentCanvas.split.locked': 'Ogni valore di {name} ha il proprio frame.',
  'componentCanvas.split.off': {
    one: 'Assegna un frame proprio a ogni valore di {name} ({count} valore)',
    other: 'Assegna un frame proprio a ogni valore di {name} ({count} valori)',
  },
  'componentCanvas.split.on': 'Mostra {name} in un solo frame',
  'componentCanvas.titleBar.close': 'Chiudi il canvas di {name}',
  'componentCanvas.zoom.fit': 'Adatta',
  'componentCanvas.zoom.fitAll': 'Adatta lo zoom a tutti i frame',
  'componentCanvas.zoom.in': 'Ingrandisci',
  'componentCanvas.zoom.out': 'Riduci',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom al 100%',
} as const satisfies CatalogOf<MessageKey>;

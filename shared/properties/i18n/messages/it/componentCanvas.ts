// Italian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Chiudi l’editor dei valori predefiniti prima di aprire un canvas.',
  'componentCanvas.error.notOpened': 'Il componente non si è aperto sul canvas. Riprova.',
  'componentCanvas.error.notReturned': 'Impossibile tornare al file in cui ti trovavi. Aprilo dal pannello Pagine.',
  'componentCanvas.error.open': 'Impossibile aprire il canvas: {message}',
  'componentCanvas.error.pageReadOnly': 'Questo canvas mostra soltanto il componente. Fai doppio clic su un frame per modificare il componente al suo interno.',
  'componentCanvas.error.previewValue': 'Un frame può mostrare in anteprima un valore per {name}, non codice.',
  'componentCanvas.error.save': 'Impossibile salvare le impostazioni del canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'non impostato',
  'componentCanvas.level.all': 'Impostato per tutti i frame',
  'componentCanvas.level.defaults':
    'Impostato nei valori predefiniti del componente (Imposta i valori predefiniti del componente). Imposta un valore qui per sostituirlo.',
  'componentCanvas.level.frame': 'Questo frame ha un proprio valore',
  'componentCanvas.level.mixed': {
    one: 'Il {count} frame qui mostra un valore diverso. Un valore impostato qui lascia invariato il valore proprio di un frame.',
    other: 'I {count} frame qui mostrano valori diversi. Un valore impostato qui lascia invariato il valore proprio di ogni frame.',
  },
  'componentCanvas.level.mixedLayout': 'Questi gruppi sono disposti in modo diverso. Scegli una disposizione per disporli tutti allo stesso modo.',
  'componentCanvas.level.mixedShared': {
    one: 'Il {count} riquadro qui mostra un valore diverso. Un valore impostato qui viene applicato.',
    other: 'I {count} riquadri qui mostrano valori diversi. Un valore impostato qui viene applicato a tutti.',
  },
  'componentCanvas.level.overrides': {
    one: '{count} frame qui mantiene un proprio valore. Reimposta per assegnargli questo.',
    other: '{count} frame qui mantengono un proprio valore. Reimposta per assegnare loro questo.',
  },
  'componentCanvas.level.part': 'Impostato per ogni frame {part}',
  'componentCanvas.level.sample': 'Un esempio che il canvas assegna a questa prop obbligatoria. Imposta un valore qui per sostituirlo.',
  'componentCanvas.menu.open': 'Apri nel canvas',
  'componentCanvas.notice.truncated': 'Vengono mostrati i primi {shown} frame su {total}. Assegna frame propri a meno props per vedere gli altri.',
  'componentCanvas.pageName': 'Canvas di {name}',
  'componentCanvas.panel.background': 'Sfondo',
  'componentCanvas.panel.backgroundVariable': 'Collega a variabile',
  'componentCanvas.panel.fixed': 'Fisso',
  'componentCanvas.panel.frames': {
    one: '{count} frame',
    other: '{count} frame',
  },
  'componentCanvas.panel.height': 'Altezza',
  'componentCanvas.panel.hug': 'Al contenuto',
  'componentCanvas.panel.layout': 'Layout', // same
  'componentCanvas.panel.layout.column': 'Impilati',
  'componentCanvas.panel.layout.row': 'Affiancati',
  'componentCanvas.panel.layout.wrap': 'A capo',
  'componentCanvas.panel.mixed': 'Misto',
  'componentCanvas.panel.overriddenHere': 'Questo componente ha un valore proprio, quindi questa modifica non si vede qui.',
  'componentCanvas.panel.pixels': '{side} in pixel',
  'componentCanvas.panel.root.about': 'Il canvas dietro tutti i frame: l’elemento html della pagina. Le sue classi si trovano nel pannello Impostazioni.',
  'componentCanvas.panel.root.title': 'Canvas', // same
  'componentCanvas.panel.scope.all': 'Tutti i frame',
  'componentCanvas.panel.scope.component': 'Questo componente',
  'componentCanvas.panel.scope.frame': 'Questo frame',
  'componentCanvas.panel.scope.hint':
    'Dove si applicano la dimensione, lo sfondo e i valori delle props che imposti: a questo frame, a tutti i frame di un valore o a tutti i frame. L’impostazione propria di un frame prevale su una più ampia.',
  'componentCanvas.panel.scope.label': 'Applica a',
  'componentCanvas.panel.scope.part': 'Tutti i frame con {part}',
  'componentCanvas.panel.scope.project': 'Tutti i componenti',
  'componentCanvas.panel.size': 'Dimensioni',
  'componentCanvas.panel.transparent': 'Trasparente',
  'componentCanvas.panel.width': 'Larghezza',
  'componentCanvas.popup.expand': 'Espandi impostazioni del frame',
  'componentCanvas.popup.minimize': 'Riduci a icona impostazioni del frame',
  'componentCanvas.popup.title': 'Impostazioni del frame',
  'componentCanvas.scope.valueFrames': 'Tutti i frame con {value}',
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

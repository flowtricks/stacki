// Italian `menu` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/menu';

export const messages = {
  'menu.app.about': 'Informazioni su Stacki',
  'menu.app.hide': 'Nascondi Stacki',
  'menu.app.hideOthers': 'Nascondi altre',
  'menu.app.quit': 'Esci da Stacki',
  'menu.app.services': 'Servizi',
  'menu.app.showAll': 'Mostra tutte',
  'menu.edit.copy': 'Copia',
  'menu.edit.copySelection': 'Copia selezione',
  'menu.edit.cut': 'Taglia',
  'menu.edit.insertElement': 'Inserisci elemento…',
  'menu.edit.paste': 'Incolla',
  'menu.edit.redo': 'Ripeti',
  'menu.edit.selectAll': 'Seleziona tutto',
  'menu.edit.title': 'Modifica',
  'menu.edit.undo': 'Annulla',
  'menu.file.checkForUpdates': 'Controlla aggiornamenti…',
  'menu.file.closeProject': 'Chiudi progetto',
  'menu.file.closeWindow': 'Chiudi finestra',
  'menu.file.openProject': 'Apri progetto…',
  'menu.file.quit': 'Esci',
  'menu.file.settings': 'Impostazioni…',
  'menu.file.title': 'File', // same
  'menu.view.actualSize': 'Dimensione reale',
  'menu.view.forceReload': 'Aggiorna sito senza cache',
  'menu.view.fullScreen': 'Attiva/disattiva schermo intero',
  'menu.view.reload': 'Aggiorna sito',
  'menu.view.reloadAllCode': 'Ricarica Stacki',
  'menu.view.title': 'Vista',
  'menu.view.toggleDevTools': 'Attiva/disattiva strumenti per sviluppatori',
  'menu.view.zoomIn': 'Ingrandisci',
  'menu.view.zoomOut': 'Riduci',
  'menu.window.bringAllToFront': 'Porta tutto in primo piano',
  'menu.window.close': 'Chiudi',
  'menu.window.minimize': 'Riduci a icona',
  'menu.window.title': 'Finestra',
  'menu.window.zoom': 'Zoom', // same
} as const satisfies CatalogOf<MessageKey>;

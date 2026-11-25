// French `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Fermez l’éditeur de valeurs par défaut avant d’ouvrir un canevas.',
  'componentCanvas.error.notOpened': 'Le composant ne s’est pas ouvert sur le canevas. Réessayez.',
  'componentCanvas.error.notReturned': 'Impossible de revenir au fichier sur lequel vous étiez. Ouvrez-le depuis le panneau Pages.',
  'componentCanvas.error.open': 'Impossible d’ouvrir le canevas : {message}',
  'componentCanvas.error.pageReadOnly': 'Ce canevas ne fait qu’afficher le composant. Double-cliquez sur un cadre pour modifier le composant qu’il contient.',
  'componentCanvas.error.previewValue': 'Un cadre peut afficher en aperçu du texte, un nombre ou un état activé ou désactivé pour {name}, mais pas du code.',
  'componentCanvas.error.save': 'Impossible d’enregistrer les réglages du canevas : {message}',
  'componentCanvas.frame.part': '{prop} : {value}',
  'componentCanvas.frame.unset': 'non défini',
  'componentCanvas.framePanel.hide': 'Masquer les réglages du cadre',
  'componentCanvas.framePanel.show': 'Afficher les réglages du cadre',
  'componentCanvas.menu.open': 'Ouvrir dans le canevas',
  'componentCanvas.notice.truncated': 'Affichage des {shown} premiers cadres sur {total}. Donnez des cadres séparés à moins de props pour voir les autres.',
  'componentCanvas.pageName': 'Canevas de {name}',
  'componentCanvas.panel.background': 'Arrière-plan',
  'componentCanvas.panel.backgroundVariable': 'Connecter à une variable',
  'componentCanvas.panel.fixed': 'Fixe',
  'componentCanvas.panel.frame.about':
    'Cliquez sur un cadre pour sélectionner son composant, et double-cliquez dessus pour modifier le composant à l’intérieur.',
  'componentCanvas.panel.frame.pick': 'Cadre',
  'componentCanvas.panel.frame.title': 'Cadre',
  'componentCanvas.panel.frames': {
    one: '{count} cadre',
    other: '{count} cadres',
  },
  'componentCanvas.panel.height': 'Hauteur',
  'componentCanvas.panel.hug': 'Au contenu',
  'componentCanvas.panel.pixels': '{side} en pixels',
  'componentCanvas.panel.scope.all': 'Tous les cadres',
  'componentCanvas.panel.scope.frame': 'Ce cadre',
  'componentCanvas.panel.scope.hint':
    'Où s’appliquent la taille, l’arrière-plan et les valeurs de props que vous définissez : à ce cadre, à tous les cadres d’une même valeur ou à tous les cadres. Le réglage propre à un cadre l’emporte sur un réglage plus large.',
  'componentCanvas.panel.scope.label': 'Appliquer à',
  'componentCanvas.panel.scope.part': 'Tous les cadres {part}',
  'componentCanvas.panel.scope.project': 'Tous les composants',
  'componentCanvas.panel.transparent': 'Transparent', // same
  'componentCanvas.panel.width': 'Largeur',
  'componentCanvas.popup.close': 'Fermer les réglages du cadre',
  'componentCanvas.popup.title': 'Réglages du cadre',
  'componentCanvas.split.full': 'Jusqu’à {max} props peuvent avoir leurs propres cadres. Désactivez-en d’abord une.',
  'componentCanvas.split.locked': 'Chaque valeur de {name} a son propre cadre.',
  'componentCanvas.split.off': {
    one: 'Donner à chaque valeur de {name} son propre cadre ({count} valeur)',
    other: 'Donner à chaque valeur de {name} son propre cadre ({count} valeurs)',
  },
  'componentCanvas.split.on': 'Afficher {name} dans un seul cadre',
  'componentCanvas.titleBar.close': 'Fermer le canevas de {name}',
  'componentCanvas.zoom.fit': 'Ajuster',
  'componentCanvas.zoom.fitAll': 'Ajuster le zoom pour afficher tous les cadres',
  'componentCanvas.zoom.in': 'Zoom avant',
  'componentCanvas.zoom.out': 'Zoom arrière',
  'componentCanvas.zoom.percent': '{percent} %',
  'componentCanvas.zoom.reset': 'Zoom à 100 %',
} as const satisfies CatalogOf<MessageKey>;

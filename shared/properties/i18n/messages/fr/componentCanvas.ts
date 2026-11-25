// French `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Fermez l’éditeur de valeurs par défaut avant d’ouvrir un canevas.',
  'componentCanvas.error.notOpened': 'Le composant ne s’est pas ouvert sur le canevas. Réessayez.',
  'componentCanvas.error.notReturned': 'Impossible de revenir au fichier sur lequel vous étiez. Ouvrez-le depuis le panneau Pages.',
  'componentCanvas.error.open': 'Impossible d’ouvrir le canevas : {message}',
  'componentCanvas.error.save': 'Impossible d’enregistrer les réglages du canevas : {message}',
  'componentCanvas.frame.part': '{prop} : {value}',
  'componentCanvas.frame.unset': 'non défini',
  'componentCanvas.menu.open': 'Ouvrir dans le canevas',
  'componentCanvas.notice.truncated': 'Affichage des {shown} premiers cadres sur {total}. Donnez des cadres séparés à moins de props pour voir les autres.',
  'componentCanvas.pageName': 'Canevas de {name}',
  'componentCanvas.panel.background': 'Arrière-plan',
  'componentCanvas.panel.backgroundVariable': 'Connecter à une variable',
  'componentCanvas.panel.fixed': 'Fixe',
  'componentCanvas.panel.frame.hint':
    'Cliquez sur le libellé d’un cadre ou sur l’espace autour de son composant pour sélectionner le cadre. Cliquez dans le composant pour le modifier.',
  'componentCanvas.panel.frame.pick': 'Cadre',
  'componentCanvas.panel.frame.title': 'Cadre',
  'componentCanvas.panel.frames': {
    one: '{count} cadre',
    other: '{count} cadres',
  },
  'componentCanvas.panel.height': 'Hauteur',
  'componentCanvas.panel.hug': 'Au contenu',
  'componentCanvas.panel.pixels': '{side} en pixels',
  'componentCanvas.panel.props.hint':
    'Les valeurs avec lesquelles ce cadre est rendu. Elles restent sur le canevas et reviennent à chaque ouverture. Elles ne sont jamais écrites dans le composant ni dans ses instances.',
  'componentCanvas.panel.props.none': 'Non défini',
  'componentCanvas.panel.props.split': 'Chaque valeur de {name} a son propre cadre.',
  'componentCanvas.panel.props.title': 'Props d’aperçu',
  'componentCanvas.panel.props.unused': 'Cette variante n’utilise pas {name}.',
  'componentCanvas.panel.scope.all': 'Tous les cadres',
  'componentCanvas.panel.scope.frame': 'Ce cadre',
  'componentCanvas.panel.scope.hint':
    'Où s’appliquent la taille, l’arrière-plan et les valeurs de props que vous définissez : à ce cadre, à tous les cadres d’une même valeur ou à tous les cadres. Le réglage propre à un cadre l’emporte sur un réglage plus large.',
  'componentCanvas.panel.scope.label': 'Appliquer à',
  'componentCanvas.panel.scope.part': 'Tous les cadres {part}',
  'componentCanvas.panel.scope.project': 'Tous les composants',
  'componentCanvas.panel.split.hint':
    'Chaque valeur d’une prop activée ici a son propre cadre, et les cadres montrent toutes les combinaisons. Une prop désactivée affiche une seule valeur par cadre, que vous définissez dans Props d’aperçu.',
  'componentCanvas.panel.split.title': 'Cadres séparés',
  'componentCanvas.panel.split.toggle': 'Donner à chaque valeur de {name} son propre cadre',
  'componentCanvas.panel.transparent': 'Transparent', // same
  'componentCanvas.panel.values': {
    one: '{count} valeur',
    other: '{count} valeurs',
  },
  'componentCanvas.panel.width': 'Largeur',
  'componentCanvas.popup.close': 'Fermer les réglages du cadre',
  'componentCanvas.popup.title': 'Réglages du cadre',
  'componentCanvas.titleBar.close': 'Fermer le canevas de {name}',
  'componentCanvas.zoom.fit': 'Ajuster',
  'componentCanvas.zoom.fitAll': 'Ajuster le zoom pour afficher tous les cadres',
  'componentCanvas.zoom.in': 'Zoom avant',
  'componentCanvas.zoom.out': 'Zoom arrière',
  'componentCanvas.zoom.percent': '{percent} %',
  'componentCanvas.zoom.reset': 'Zoom à 100 %',
} as const satisfies CatalogOf<MessageKey>;

// French `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat IA',
  'rail.appWaiting': '{name} : {count} en attente',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Ressources',
  'rail.audits': 'Audits', // same
  'rail.cms': 'CMS', // same
  'rail.code': 'Code', // same
  'rail.collections': 'Collections', // same
  'rail.components': 'Composants',
  'rail.editorPanels': 'Panneaux de l’éditeur',
  'rail.elements': 'Ajouter des éléments',
  'rail.files': 'Fichiers',
  'rail.history': 'Git', // same
  'rail.more': 'Plus',
  'rail.moveDown': 'Déplacer vers le bas',
  'rail.moveToRail': 'Déplacer vers la barre latérale',
  'rail.moveUp': 'Déplacer vers le haut',
  'rail.movedBottom': '{label} : groupe du bas, position {position} sur {count}',
  'rail.movedSettings': '{label} : Réglages, position {position} sur {count}',
  'rail.movedTop': '{label} : groupe du haut, position {position} sur {count}',
  'rail.navigator': 'Navigateur',
  'rail.orderMenu': 'Ordre de la barre',
  'rail.pages': 'Pages', // same
  'rail.properties': 'Propriétés',
  'rail.selectors': 'Sélecteurs de style',
  'rail.settings': 'Réglages',
  'rail.settingsEmpty': 'Faites glisser ici les icônes de la barre latérale pour les garder dans Réglages',
  'rail.settingsOrder.description': 'Faites glisser les icônes de la barre latérale pour les réorganiser. Rétablissez l’ordre par défaut.',
  'rail.settingsOrder.done': 'Ordre de la barre latérale rétabli',
  'rail.settingsOrder.label': 'Ordre des icônes de la barre latérale',
  'rail.settingsOrder.reset': 'Rétablir par défaut',
  'rail.variables': 'Variables', // same
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;

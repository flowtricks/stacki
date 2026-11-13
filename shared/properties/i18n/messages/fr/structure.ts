// French `structure` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/structure';

export const messages = {
  'structure.collapseAll': 'Tout réduire',
  'structure.dragHere': 'Faites glisser des composants ici',
  'structure.error.needsDeveloper': 'Cette page nécessite qu’un développeur corrige sa source avant toute modification.',
  'structure.error.openCode': 'Ouvrir le panneau de code',
  'structure.error.syntax': 'Cette page contient une erreur de syntaxe.',
  'structure.error.syntaxNear': '{message} Près de {near}',
  'structure.expandAll': 'Tout développer',
  'structure.frontmatter': 'Frontmatter', // same
  'structure.imports': { one: '1 import', other: '{count} imports' }, // same
  'structure.menu.convertTo': 'Convertir en',
  'structure.menu.copy': 'Copier',
  'structure.menu.cut': 'Couper',
  'structure.menu.delete': 'Supprimer',
  'structure.menu.duplicate': 'Dupliquer',
  'structure.menu.label': 'Actions de l’élément',
  'structure.menu.openComponent': 'Ouvrir le composant',
  'structure.menu.paste': 'Coller',
  'structure.menu.setDefaults': 'Définir les valeurs par défaut du composant',
  'structure.menu.wrapIn': 'Envelopper dans',
  'structure.missing.injected':
    '{route} provient de {from}, pas de ce projet : elle peut être prévisualisée ici, mais son balisage se trouve dans une dépendance et n’est pas modifiable.',
  'structure.missing.integration': 'une intégration',
  'structure.missing.select': 'Sélectionnez une page à modifier.',
  'structure.row.imported': 'Importé depuis {file}',
  'structure.status.empty': 'N’affiche rien sur la page avec ses props actuelles',
  'structure.status.hidden': 'display: none — présent sur la page, mais non affiché',
  'structure.status.inert': 'pointer-events: none — affiché, mais ne reçoit aucun clic',
} as const satisfies CatalogOf<MessageKey>;

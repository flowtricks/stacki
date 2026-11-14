// French `variables` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/variables';

export const messages = {
  'variables.cell.chooseColor': 'Choisissez la couleur de {name}',
  'variables.cell.editCurve': 'Modifier la courbe de {name}',
  'variables.count': { one: '1 variable', other: '{count} variables' }, // same
  'variables.dragToReorder': 'Faites glisser pour réorganiser',
  'variables.error.add': 'Impossible d’ajouter cet élément.',
  'variables.error.alreadyDeclared': '{name} est déjà déclarée dans {selector}.',
  'variables.error.alreadyExists': '{name} existe déjà.',
  'variables.error.badVariableName': '« {name} » ne peut pas être un nom de variable.',
  'variables.error.changedSincePanelRead': 'Ce fichier a changé depuis la lecture par le panneau.',
  'variables.error.collaboratorChanged': 'Un collaborateur a modifié cette source. Actualisez et réessayez.',
  'variables.error.delete': 'Impossible de supprimer cet élément.',
  'variables.error.duplicate': 'Impossible de dupliquer cet élément.',
  'variables.error.headingCannotContainCommentEnd': 'Un titre ne peut pas contenir "*/".',
  'variables.error.headingNeedsName': 'Un titre a besoin d’un nom.',
  'variables.error.headingNotComment': 'Ce titre n’est plus un commentaire.',
  'variables.error.move': 'Impossible de déplacer cet élément.',
  'variables.error.notDeclared': '{name} n’est plus déclarée à cet endroit.',
  'variables.error.notVariableName': '{name} n’est pas un nom de variable.',
  'variables.error.nothingToHead': '{selector} n’a rien à titrer.', // review
  'variables.error.outsideStyleBlock': 'Cela modifierait le fichier en dehors de son bloc {tag}, il n’a donc pas été enregistré.',
  'variables.error.parse': 'Analyse impossible — {detail}',
  'variables.error.placeGone': 'Cet emplacement n’est plus dans le fichier.',
  'variables.error.prefixHeading': 'Ce titre est un préfixe de nom, pas un commentaire CSS.',
  'variables.error.rename': 'Impossible de renommer cet élément.',
  'variables.error.renamedTwice': '{name} est renommée deux fois en une seule opération.',
  'variables.error.restart': 'Stacki doit être redémarré avant de pouvoir l’utiliser.',
  'variables.error.restoreRename': 'Impossible de rétablir le renommage.',
  'variables.error.restoreStylesheet': 'Impossible de restaurer cette feuille de style.',
  'variables.error.ruleGone': '{selector} n’est plus dans {file}.',
  'variables.error.ruleInSeveralBlocks': '{selector} figure dans plusieurs blocs {tag} de {file}. Modifiez celui-ci dans le code.',
  'variables.error.sameNameTwice': 'Deux variables porteraient le même nom, {name}.',
  'variables.error.styleBlockLine': 'Le bloc {tag} à la ligne {line} : {detail}',
  'variables.error.variablesNotDeclared': 'Ces variables ne sont plus déclarées à cet endroit.',
  'variables.error.write': 'Impossible d’écrire cette valeur.',
  'variables.fluid.error':
    'N’atteint pas 2 fois sa taille d’origine avec un zoom de 500 %. Réduisez l’écart entre la taille maximale et minimale de la variable.',
  'variables.fluid.labelError': 'Erreur d’accessibilité : {message}',
  'variables.fluid.labelWarning': 'Avertissement d’accessibilité : {message}',
  'variables.fluid.readWhy': 'Voir pourquoi',
  'variables.fluid.warning': 'Rétrécit quand le zoom augmente. Augmentez l’écart entre la taille maximale et minimale de la fenêtre.',
  'variables.group.options': 'Options du groupe',
  'variables.head.name': 'Nom',
  'variables.head.value': 'Valeur',
  'variables.hidden.indicator': 'Masquée dans les suggestions de variables',
  'variables.menu.delete': 'Supprimer',
  'variables.menu.duplicate': 'Dupliquer',
  'variables.menu.rename': 'Renommer',
  'variables.modes': { one: '1 mode', other: '{count} modes' }, // same
  'variables.name.clickToRename': 'Cliquez pour renommer',
  'variables.name.dragOrRename': '{name} : faites glisser pour déplacer, cliquez pour renommer',
  'variables.new': 'Nouvelle variable',
  'variables.noMatches': 'Aucun résultat pour la recherche.',
  'variables.panel.allFiles': 'Tous les fichiers',
  'variables.panel.cssVariables': 'variables CSS',
  'variables.panel.empty': 'Aucune propriété personnalisée CSS trouvée dans les feuilles de style ou les balises {tag} de ce projet.',
  'variables.saved': 'Enregistré',
  'variables.scope.page': 'Cette page',
  'variables.scope.pageDetail': 'Déclarée dans un {tag} de cette page, elle ne s’applique que sur cette page.',
  'variables.scope.rendered': 'Là où elle s’affiche',
  'variables.scope.renderedDetail': 'Déclarée dans un {tag} de ce fichier, elle ne s’applique que sur les pages qui l’affichent.',
  'variables.scope.scoped': 'Ce fichier uniquement',
  'variables.scope.scopedDetail': 'Astro limite la portée de ce {tag} : cette règle n’atteint que les éléments écrits dans ce fichier.',
  'variables.scope.writtenGlobal': 'Le bloc est is:global : Astro l’empaquette sans limiter sa portée.',
  'variables.scope.writtenInline': 'Le bloc est is:inline : Astro le laisse dans la page tel quel.',
  'variables.scope.writtenScoped': 'Le bloc est un {tag} simple : :root, html, body et :global() restent sans portée, tous les autres sélecteurs sont limités.',
  'variables.scroll.label': 'Faire défiler les valeurs des variables horizontalement',
  'variables.search': 'Rechercher des variables',
  'variables.settings.hideFromSuggestions': 'Masquer dans les suggestions de variables',
  'variables.settings.menu': 'Réglages de la variable',
  'variables.settings.open': 'Réglages de {name}',
  'variables.title': 'Variables', // same
  'variables.type.color': 'Couleur',
  'variables.type.number': 'Nombre',
  'variables.type.size': 'Taille',
  'variables.type.text': 'Texte',
  'variables.undo.deleteGroup': 'la suppression du groupe', // review
  'variables.undo.group': 'le groupe', // review
  'variables.undo.groupRename': 'le renommage du groupe', // review
  'variables.undo.heading': 'le titre', // review
  'variables.undo.move': 'le déplacement', // review
  'variables.undo.rename': 'le renommage', // review
  'variables.undo.value': 'la valeur', // review
  'variables.undo.variable': 'la variable', // review
  'variables.visibility.blocked': 'Les suggestions de variables ne sont pas filtrées : {detail} Le masquage est suspendu pour ne pas écraser ce fichier.',
  'variables.visibility.saveFailed': 'Impossible d’enregistrer les variables masquées : {detail}',
} as const satisfies CatalogOf<MessageKey>;

// French `history` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/history';

export const messages = {
  'history.backToNow': 'Revenir à maintenant',
  'history.commit.actions': 'Actions du commit',
  'history.commit.merge': 'Commit de fusion', // review
  'history.commit.preview': 'Aperçu',
  'history.commit.restoreProject': 'Restaurer le projet à ce commit…', // review
  'history.commit.you': 'Vous',
  'history.day.today': 'Aujourd’hui',
  'history.day.yesterday': 'Hier',
  'history.dialog.close': 'Fermer les fichiers modifiés',
  'history.dialog.title': 'Fichiers modifiés ({count})',
  'history.diff.allFiles': 'Tous les fichiers',
  'history.diff.emptyTree': 'Arbre vide', // review
  'history.diff.firstParent': 'comparé au premier parent', // review
  'history.diff.label': 'Différences du fichier',
  'history.diff.loading': 'Chargement des différences…',
  'history.diff.noTextChanges': 'Aucun changement de texte dans ce fichier.',
  'history.diff.restoreFile': 'Restaurer le fichier…',
  'history.error.diffTooLarge': 'Les différences de ce fichier sont trop volumineuses pour être affichées.',
  'history.error.diffTooManyLines': 'Les différences de ce fichier comptent trop de lignes pour être affichées.',
  'history.error.diffUnreadable': 'Impossible de lire les différences de ce commit.',
  'history.files.added': {
    one: '{count} fichier ajouté',
    other: '{count} fichiers ajoutés',
  },
  'history.files.changedLabel': 'fichiers modifiés',
  'history.files.count': {
    one: '{count} fichier',
    other: '{count} fichiers',
  },
  'history.files.deleted': {
    one: '{count} fichier supprimé',
    other: '{count} fichiers supprimés',
  },
  'history.files.from': 'Depuis {path}',
  'history.files.listLabel': 'Liste des fichiers modifiés',
  'history.files.noMatch': 'Aucun fichier ne correspond à ce filtre.',
  'history.files.none': 'Aucun fichier modifié.',
  'history.files.unavailable': 'Les fichiers modifiés ne sont pas disponibles pour ce commit.',
  'history.files.updated': {
    one: '{count} fichier mis à jour',
    other: '{count} fichiers mis à jour',
  },
  'history.files.view': 'Voir les fichiers modifiés ({count})',
  'history.files.viewDiff': 'Voir les différences de {path}',
  'history.filter.added': 'Nouveaux',
  'history.filter.all': 'Tous',
  'history.filter.deleted': 'Supprimés',
  'history.filter.label': 'Filtrer les fichiers modifiés',
  'history.filter.updated': 'Modifiés',
  'history.scope.all': 'Toutes les branches',
  'history.scope.ariaLabel': 'Filtrer les commits par branche',
  'history.scope.current': 'Branche actuelle',
  'history.scope.label': 'Filtrer les commits',
  'history.scope.showing': 'Commits affichés sur {branch}',
  'history.sort.ariaLabel': 'Trier les fichiers modifiés',
  'history.sort.label': 'Trier',
  'history.sort.path': 'Chemin du fichier',
  'history.sort.status': 'Statut',
  'history.summary.moreFiles': {
    one: '{first} et {count} autre fichier',
    other: '{first} et {count} autres fichiers',
  },
  'history.summary.morePages': {
    one: '{first} et {count} autre page',
    other: '{first} et {count} autres pages',
  },
  'history.summary.none': 'Aucun fichier modifié',
  'history.summary.two': '{first} et {second}',
  'history.time.daysAgo': {
    one: 'il y a {count} jour',
    other: 'il y a {count} jours',
  },
  'history.time.hoursAgo': {
    one: 'il y a {count} heure',
    other: 'il y a {count} heures',
  },
  'history.time.justNow': 'à l’instant',
  'history.time.minutesAgo': {
    one: 'il y a {count} minute',
    other: 'il y a {count} minutes',
  },
  'history.time.yesterday': 'hier',
  'history.timeline.empty':
    'Rien n’est encore enregistré. Une fois votre première version enregistrée, elle apparaîtra ici et vous pourrez y revenir quand vous voulez.',
  'history.timeline.label': 'Historique Git',
  'history.timeline.showOlder': 'Afficher les plus anciens',
  'history.versionHistory': 'Historique des versions',
} as const satisfies CatalogOf<MessageKey>;

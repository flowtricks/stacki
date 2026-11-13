// German `history` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/history';

export const messages = {
  'history.backToNow': 'Zurück zu jetzt',
  'history.commit.actions': 'Commit-Aktionen',
  'history.commit.merge': 'Merge-Commit', // review
  'history.commit.preview': 'Vorschau',
  'history.commit.restoreProject': 'Projekt auf diesen Commit zurücksetzen …', // review
  'history.commit.you': 'Du',
  'history.day.today': 'Heute',
  'history.day.yesterday': 'Gestern',
  'history.dialog.close': 'Geänderte Dateien schließen',
  'history.dialog.title': 'Geänderte Dateien ({count})',
  'history.diff.allFiles': 'Alle Dateien',
  'history.diff.emptyTree': 'Leerer Baum', // review
  'history.diff.firstParent': 'verglichen mit dem ersten Elternteil', // review
  'history.diff.label': 'Datei-Diff',
  'history.diff.loading': 'Diff wird geladen …',
  'history.diff.noTextChanges': 'Keine Textänderungen in dieser Datei.',
  'history.diff.restoreFile': 'Datei wiederherstellen …',
  'history.error.diffTooLarge': 'Der Diff dieser Datei ist zu groß, um angezeigt zu werden.',
  'history.error.diffTooManyLines': 'Der Diff dieser Datei hat zu viele Zeilen, um angezeigt zu werden.',
  'history.error.diffUnreadable': 'Der Diff dieses Commits konnte nicht gelesen werden.',
  'history.files.added': {
    one: '{count} Datei hinzugefügt',
    other: '{count} Dateien hinzugefügt',
  },
  'history.files.changedLabel': 'geänderte Dateien',
  'history.files.count': {
    one: '{count} Datei',
    other: '{count} Dateien',
  },
  'history.files.deleted': {
    one: '{count} Datei gelöscht',
    other: '{count} Dateien gelöscht',
  },
  'history.files.from': 'Von {path}',
  'history.files.listLabel': 'Liste der geänderten Dateien',
  'history.files.noMatch': 'Keine Dateien passen zu diesem Filter.',
  'history.files.none': 'Keine Dateien geändert.',
  'history.files.unavailable': 'Die geänderten Dateien sind für diesen Commit nicht verfügbar.',
  'history.files.updated': {
    one: '{count} Datei aktualisiert',
    other: '{count} Dateien aktualisiert',
  },
  'history.files.view': 'Geänderte Dateien anzeigen ({count})',
  'history.files.viewDiff': 'Diff für {path} anzeigen',
  'history.filter.added': 'Neu',
  'history.filter.all': 'Alle',
  'history.filter.deleted': 'Gelöscht',
  'history.filter.label': 'Geänderte Dateien filtern',
  'history.filter.updated': 'Geändert',
  'history.scope.all': 'Alle Branches',
  'history.scope.ariaLabel': 'Commits nach Branch filtern',
  'history.scope.current': 'Aktueller Branch',
  'history.scope.label': 'Commits filtern',
  'history.scope.showing': 'Commits auf {branch} werden angezeigt',
  'history.sort.ariaLabel': 'Geänderte Dateien sortieren',
  'history.sort.label': 'Sortieren',
  'history.sort.path': 'Dateipfad',
  'history.sort.status': 'Status', // same
  'history.summary.moreFiles': {
    one: '{first} und {count} weitere Datei',
    other: '{first} und {count} weitere Dateien',
  },
  'history.summary.morePages': {
    one: '{first} und {count} weitere Seite',
    other: '{first} und {count} weitere Seiten',
  },
  'history.summary.none': 'Keine Dateien geändert',
  'history.summary.two': '{first} und {second}',
  'history.time.daysAgo': {
    one: 'vor {count} Tag',
    other: 'vor {count} Tagen',
  },
  'history.time.hoursAgo': {
    one: 'vor {count} Stunde',
    other: 'vor {count} Stunden',
  },
  'history.time.justNow': 'gerade eben',
  'history.time.minutesAgo': {
    one: 'vor {count} Minute',
    other: 'vor {count} Minuten',
  },
  'history.time.yesterday': 'gestern',
  'history.timeline.empty':
    'Noch nichts gespeichert. Sobald du deine erste Version speicherst, erscheint sie hier und du kannst jederzeit zu ihr zurückkehren.',
  'history.timeline.label': 'Git-Verlauf',
  'history.timeline.showOlder': 'Ältere anzeigen',
  'history.versionHistory': 'Versionsverlauf',
} as const satisfies CatalogOf<MessageKey>;

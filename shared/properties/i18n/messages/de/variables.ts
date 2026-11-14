// German `variables` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/variables';

export const messages = {
  'variables.cell.chooseColor': 'Farbe für {name} wählen',
  'variables.cell.editCurve': 'Kurve für {name} bearbeiten',
  'variables.count': { one: '1 Variable', other: '{count} Variablen' },
  'variables.dragToReorder': 'Zum Neuordnen ziehen',
  'variables.error.add': 'Das konnte nicht hinzugefügt werden.',
  'variables.error.alreadyDeclared': '{name} ist bereits in {selector} deklariert.',
  'variables.error.alreadyExists': '{name} existiert bereits.',
  'variables.error.badVariableName': '„{name}“ kann kein Variablenname sein.',
  'variables.error.changedSincePanelRead': 'Diese Datei hat sich geändert, seit das Panel sie gelesen hat.',
  'variables.error.collaboratorChanged': 'Ein Mitarbeiter hat diese Quelle geändert. Aktualisiere und versuche es erneut.',
  'variables.error.delete': 'Das konnte nicht gelöscht werden.',
  'variables.error.duplicate': 'Das konnte nicht dupliziert werden.',
  'variables.error.headingCannotContainCommentEnd': 'Eine Überschrift darf kein "*/" enthalten.',
  'variables.error.headingNeedsName': 'Eine Überschrift braucht einen Namen.',
  'variables.error.headingNotComment': 'Diese Überschrift ist kein Kommentar mehr.',
  'variables.error.move': 'Das konnte nicht verschoben werden.',
  'variables.error.notDeclared': '{name} ist dort nicht mehr deklariert.',
  'variables.error.notVariableName': '{name} ist kein Variablenname.',
  'variables.error.nothingToHead': '{selector} hat nichts, dem eine Überschrift vorangehen könnte.', // review
  'variables.error.outsideStyleBlock': 'Das würde die Datei außerhalb ihres {tag}-Blocks ändern, deshalb wurde nicht gespeichert.',
  'variables.error.parse': 'Konnte nicht gelesen werden — {detail}',
  'variables.error.placeGone': 'Diese Stelle ist nicht mehr in der Datei.',
  'variables.error.prefixHeading': 'Diese Überschrift ist ein Namenspräfix, kein CSS-Kommentar.',
  'variables.error.rename': 'Das konnte nicht umbenannt werden.',
  'variables.error.renamedTwice': '{name} wird in einem Durchgang zweimal umbenannt.',
  'variables.error.restart': 'Stacki muss neu gestartet werden, bevor das verwendet werden kann.',
  'variables.error.restoreRename': 'Die Umbenennung konnte nicht wiederhergestellt werden.',
  'variables.error.restoreStylesheet': 'Das Stylesheet konnte nicht wiederhergestellt werden.',
  'variables.error.ruleGone': '{selector} ist nicht mehr in {file}.',
  'variables.error.ruleInSeveralBlocks': '{selector} steht in mehr als einem {tag}-Block von {file}. Bearbeite diesen im Code.',
  'variables.error.sameNameTwice': 'Zwei Variablen würden beide {name} heißen.',
  'variables.error.styleBlockLine': 'Der {tag}-Block in Zeile {line}: {detail}',
  'variables.error.variablesNotDeclared': 'Diese Variablen sind dort nicht mehr deklariert.',
  'variables.error.write': 'Der Wert konnte nicht geschrieben werden.',
  'variables.fluid.error':
    'Erreicht bei 500 % Zoom nicht das Doppelte der Originalgröße. Verringere den Unterschied zwischen größter und kleinster Variablengröße.',
  'variables.fluid.labelError': 'Barrierefreiheitsfehler: {message}',
  'variables.fluid.labelWarning': 'Barrierefreiheitswarnung: {message}',
  'variables.fluid.readWhy': 'Warum lesen',
  'variables.fluid.warning': 'Wird beim Vergrößern des Zooms kleiner. Erhöhe den Unterschied zwischen größter und kleinster Viewport-Größe.',
  'variables.group.options': 'Gruppenoptionen',
  'variables.head.name': 'Name', // same
  'variables.head.value': 'Wert',
  'variables.hidden.indicator': 'In den Variablenvorschlägen ausgeblendet',
  'variables.menu.delete': 'Löschen',
  'variables.menu.duplicate': 'Duplizieren',
  'variables.menu.rename': 'Umbenennen',
  'variables.modes': { one: '1 Modus', other: '{count} Modi' },
  'variables.name.clickToRename': 'Zum Umbenennen klicken',
  'variables.name.dragOrRename': '{name} – ziehen zum Verschieben, klicken zum Umbenennen',
  'variables.new': 'Neue Variable',
  'variables.noMatches': 'Keine Treffer für die Suche.',
  'variables.panel.allFiles': 'Alle Dateien',
  'variables.panel.cssVariables': 'CSS-Variablen',
  'variables.panel.empty': 'Keine benutzerdefinierten CSS-Eigenschaften in den Stylesheets oder {tag}-Tags dieses Projekts gefunden.',
  'variables.saved': 'Gespeichert',
  'variables.scope.page': 'Diese Seite',
  'variables.scope.pageDetail': 'In einem {tag} dieser Seite deklariert, gilt also nur auf dieser Seite.',
  'variables.scope.rendered': 'Wo gerendert',
  'variables.scope.renderedDetail': 'In einem {tag} dieser Datei deklariert, gilt also nur auf Seiten, die sie rendern.',
  'variables.scope.scoped': 'Nur diese Datei',
  'variables.scope.scopedDetail': 'Astro begrenzt dieses {tag} auf seinen Bereich, die Regel betrifft also nur Elemente aus dieser Datei.',
  'variables.scope.writtenGlobal': 'Der Block ist is:global: Astro bündelt ihn ohne Bereichsbegrenzung.',
  'variables.scope.writtenInline': 'Der Block ist is:inline: Astro lässt ihn genau so auf der Seite stehen.',
  'variables.scope.writtenScoped':
    'Der Block ist ein einfaches {tag}: :root, html, body und :global() bleiben unbegrenzt, alle anderen Selektoren sind begrenzt.',
  'variables.scroll.label': 'Variablenwerte horizontal scrollen',
  'variables.search': 'Variablen suchen',
  'variables.settings.hideFromSuggestions': 'In Variablenvorschlägen ausblenden',
  'variables.settings.menu': 'Variableneinstellungen',
  'variables.settings.open': 'Einstellungen für {name}',
  'variables.title': 'Variablen',
  'variables.type.color': 'Farbe',
  'variables.type.number': 'Zahl',
  'variables.type.size': 'Größe',
  'variables.type.text': 'Text', // same
  'variables.undo.deleteGroup': 'das Löschen der Gruppe', // review
  'variables.undo.group': 'die Gruppe', // review
  'variables.undo.groupRename': 'die Gruppenumbenennung', // review
  'variables.undo.heading': 'die Überschrift', // review
  'variables.undo.move': 'das Verschieben', // review
  'variables.undo.rename': 'die Umbenennung', // review
  'variables.undo.value': 'den Wert', // review
  'variables.undo.variable': 'die Variable', // review
  'variables.visibility.blocked': 'Variablenvorschläge werden nicht gefiltert: {detail} Ausblenden ist pausiert, damit diese Datei nicht überschrieben wird.',
  'variables.visibility.saveFailed': 'Ausgeblendete Variablen konnten nicht gespeichert werden: {detail}',
} as const satisfies CatalogOf<MessageKey>;

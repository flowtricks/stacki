// German `componentProps` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentProps';

export const messages = {
  'componentProps.attributes.addDefault': 'Standardattribut hinzufügen',
  'componentProps.attributes.connections': 'Verbindungen',
  'componentProps.attributes.connectionsCount': { one: 'Verbindungen: {count} Element', other: 'Verbindungen: {count} Elemente' },
  'componentProps.attributes.defaultName': 'Name des Standardattributs {number}',
  'componentProps.attributes.defaultValue': 'Wert des Standardattributs {number}',
  'componentProps.attributes.defaults': 'Standardattribute',
  'componentProps.attributes.defaultsDiffer': 'Die verbundenen Elemente haben unterschiedliche Standardwerte; wenn du einen änderst, erhalten alle diese.',
  'componentProps.attributes.name': 'Name', // same
  'componentProps.attributes.namePlaceholder': 'Name',
  'componentProps.attributes.noSpread': 'Noch kein Element verteilt {spread}. Verbinde eins über den Bindepunkt seiner Attribute.', // review
  'componentProps.attributes.passThrough': 'Reicht alle anderen Attribute über {spread} weiter.',
  'componentProps.attributes.removeDefault': 'Standardattribut {name} entfernen',
  'componentProps.attributes.rowKind': { one: 'Attribute · {count} Element', other: 'Attribute · {count} Elemente' },
  'componentProps.attributes.select': '{name} auswählen',
  'componentProps.attributes.title': 'Attribut-Eigenschaft',
  'componentProps.attributes.tooltipDefault': 'Attribute, die eine Instanz den verbundenen Elementen hinzufügt',
  'componentProps.attributes.valuePlaceholder': 'Wert',
  'componentProps.autosave.conflict':
    'Diese Datei hat sich auf dem Datenträger geändert, deshalb wurde das Formular neu geladen. Deine Änderung blieb erhalten.',
  'componentProps.declaration.default': 'Standard (Zeile {line}): {expression}',
  'componentProps.declaration.details': 'Deklarationsdetails',
  'componentProps.declaration.source': '{label} (Zeile {line}): {expression}',
  'componentProps.declaration.variantRules': 'Variantenregeln',
  'componentProps.default.none': 'Kein Standardwert',
  'componentProps.default.number': 'Standardzahl',
  'componentProps.default.search': 'Standardwerte suchen …',
  'componentProps.default.text': 'Standardtext',
  'componentProps.default.useControl': 'Steuerelement für den Standardwert verwenden',
  'componentProps.default.value': 'Standardwert',
  'componentProps.default.writeExpression': 'Standardausdruck schreiben',
  'componentProps.defaults.badCode': 'Der Standard für {value} ist kein gültiger Code.', // review
  'componentProps.defaults.computed': 'Berechnet', // review
  'componentProps.defaults.conditional': 'Nach Bedingungen festlegen', // review
  'componentProps.defaults.discard': 'Änderungen verwerfen',
  'componentProps.defaults.entryRead': 'Der Code liest {value} direkt aus {name}. Ändere es im Quellcode.', // review
  'componentProps.defaults.missingTable': '{name} hat keine Standards pro Option zum Bearbeiten.', // review
  'componentProps.defaults.perOption': 'Beginne jede Gruppe mit {controller} und einer Option.', // review
  'componentProps.defaults.return': 'Zurück zu den Standardwerten',
  'componentProps.defaults.saveFailed': 'Die Standardwerte der Komponente konnten nicht gespeichert werden.',
  'componentProps.defaults.saved': 'Standardwerte in diesem Projekt gespeichert.',
  'componentProps.defaults.tableReset':
    'Die Komponente berechnet diesen Standard aus ihrer eigenen Tabelle: Ändere den Standard jeder Option in den Bedingungen oder die Tabelle im Quelltext.', // review
  'componentProps.dialog.close': 'Eigenschaftseinstellungen schließen',
  'componentProps.dialog.loading': 'Eigenschaft wird geladen …',
  'componentProps.dialog.title': 'Eigenschaftseinstellungen',
  'componentProps.editor.delete': 'Eigenschaft löschen',
  'componentProps.editor.deleteNamed': '{name} löschen',
  'componentProps.editor.name': 'Name', // same
  'componentProps.editor.newProperty': 'Neue Eigenschaft',
  'componentProps.editor.renameHelp':
    'Beim Umbenennen werden die Eigenschaft dieser Komponente, die Variable, die sie liest, und ihre Instanzen auf der ganzen Website aktualisiert.',
  'componentProps.editor.renameShared': 'Beim Umbenennen werden {typeName} und jeder Zugriff darauf in diesen Dateien umgeschrieben:', // review
  'componentProps.kind.attributes': 'Attribute',
  'componentProps.kind.choice': 'Auswahl',
  'componentProps.kind.code': 'Codetyp …',
  'componentProps.kind.color': 'Farbe',
  'componentProps.kind.curated': 'Ausgewählte Einträge',
  'componentProps.kind.date': 'Datum',
  'componentProps.kind.filter': 'Filter', // same
  'componentProps.kind.group': 'Gruppe',
  'componentProps.kind.image': 'Bild',
  'componentProps.kind.link': 'Link', // same
  'componentProps.kind.list': 'Liste',
  'componentProps.kind.number': 'Zahl',
  'componentProps.kind.record': 'Schlüssel-Wert-Liste',
  'componentProps.kind.sort': 'Sortierung',
  'componentProps.kind.switch': 'Schalter',
  'componentProps.kind.text': 'Text', // same
  'componentProps.kindHint.attributes': 'Aus den Attributen eines Elements',
  'componentProps.kindHint.choice': 'Eins aus einer Liste',
  'componentProps.kindHint.code': 'TypeScript-Typ schreiben',
  'componentProps.kindHint.curated': 'Auswahl der Sammlungsliste',
  'componentProps.kindHint.filter': 'Filter der Sammlungsliste',
  'componentProps.kindHint.group': 'Felder in einem Objekt',
  'componentProps.kindHint.list': 'Einträge mit Feldern',
  'componentProps.kindHint.sort': 'Sortierung der Sammlungsliste',
  'componentProps.kindSection.advanced': 'Erweitert',
  'componentProps.kindSection.basic': 'Grundlegend',
  'componentProps.kindSection.collection': 'Sammlungsliste',
  'componentProps.kindSection.element': 'Element', // same
  'componentProps.kindSection.media': 'Medien & Links',
  'componentProps.kindSection.structure': 'Struktur',
  'componentProps.options.title': 'Optionen',
  'componentProps.panel.add': 'Eigenschaft hinzufügen',
  'componentProps.panel.deletedIn': '{name} wird in {path} gelöscht',
  'componentProps.panel.empty': 'Noch keine Eigenschaften. Füge eine hinzu, um festzulegen, was jede Instanz anpassen kann.',
  'componentProps.panel.from': 'Aus {typeName}',
  'componentProps.panel.label': 'Komponenteneigenschaften',
  'componentProps.panel.loading': 'Eigenschaften werden geladen …',
  'componentProps.panel.openFile': '{path} öffnen',
  'componentProps.panel.propertyGone': 'Diese Komponente hat keine Eigenschaft {name} mehr.',
  'componentProps.panel.required': 'Erforderlich',
  'componentProps.panel.saveBusy': 'Ein anderer Speichervorgang läuft noch. Versuche es erneut.',
  'componentProps.panel.title': 'Eigenschaften',
  'componentProps.panel.unused': 'In dieser Komponente nicht verwendet',
  'componentProps.problem.decimalsRange': 'Dezimalstellen liegen zwischen 0 und {max}.',
  'componentProps.problem.decimalsWhole': 'Dezimalstellen sind eine ganze Zahl.',
  'componentProps.problem.minAboveMax': 'Das Minimum liegt über dem Maximum.',
  'componentProps.problem.nameShape': 'Verwende einen Namen wie title, imageUrl oder isVisible.',
  'componentProps.problem.typeMissing': 'Gib der Eigenschaft einen Typ.',
  'componentProps.reorder.hint': 'Zum Neuordnen ziehen (oder Pfeiltasten verwenden)',
  'componentProps.reorder.label': '{name} neu anordnen',
  'componentProps.settings.auto': 'Auto', // same
  'componentProps.settings.decimals': 'Dezimalstellen',
  'componentProps.settings.decimalsHint': 'Wie viele Dezimalstellen die Zahl behält: 0 ist eine ganze Zahl, höchstens {max}.',
  'componentProps.settings.defaultNote': 'Der Standardwert: {note}',
  'componentProps.settings.legacyRemove': { one: 'Entfernen', other: 'Entfernen' },
  'componentProps.settings.legacyTags': {
    one: 'Dieser Doc-Kommentar enthält ein ungenutztes Schalter-Label-Tag, das nichts liest.',
    other: 'Dieser Doc-Kommentar enthält ungenutzte Schalter-Label-Tags, die nichts liest.',
  }, // review
  'componentProps.settings.max': 'Max.',
  'componentProps.settings.min': 'Min.',
  'componentProps.settings.none': 'Keiner',
  'componentProps.settings.numberGroup': 'Zahleneinstellungen',
  'componentProps.settings.numberMalformed': 'Gib eine Zahl ein oder lass das Feld leer für keine.',
  'componentProps.settings.tooltip': 'Tooltip', // same
  'componentProps.settings.tooltipPlaceholder': 'Beschreibe, wie diese Eigenschaft verwendet wird …',
  'componentProps.settings.useControls': 'Steuerelemente verwenden', // review
  'componentProps.settings.viewCode': 'TypeScript anzeigen', // review
  'componentProps.share.components': 'Komponenten',
  'componentProps.share.declaredIn': 'Deklariert in',
  'componentProps.share.defaults': 'Standardwerte',
  'componentProps.share.instancesIn': 'Instanzen in',
  'componentProps.share.summary': {
    one: 'Geteilt: ändert {typeName} in {path}, verwendet von {count} Komponente ({names}) und deren Instanzen.',
    other: 'Geteilt: ändert {typeName} in {path}, verwendet von {count} Komponenten ({names}) und deren Instanzen.',
  }, // review
  'componentProps.tooltips.perOption': 'Ein Tooltip kann nur von {controller} abhängen.', // review
  'componentProps.type.attributesNote': 'Eine Attribut-Eigenschaft entsteht aus einem Element: Öffne den Bindepunkt seiner Attribute.',
  'componentProps.type.codeType': 'Codetyp',
  'componentProps.type.controllerKind': 'Seine Optionen bestimmen die Art', // review
  'componentProps.type.defaultCleared': 'Der Standardwert wurde gelöscht: Er passt nicht zu „{kind}“.',
  'componentProps.type.kind': 'Art', // review
  'componentProps.type.noType': 'Kein Typ',
  'componentProps.type.search': 'Arten suchen …', // review
  'componentProps.type.typescript': 'TypeScript', // same
  'componentProps.variants.badIndex': 'Diese Position liegt außerhalb der Optionen.', // review
  'componentProps.variants.badValue': 'Verwende einen kurzen Namen ohne Anführungszeichen oder Backslashes.', // review
  'componentProps.variants.booleanOptions': '{name} ist true oder false: Seine zwei Optionen lassen sich nicht hinzufügen, umbenennen oder entfernen.', // review
  'componentProps.variants.cannotAttach':
    '{name} ist nicht in den Eigenschaften deklariert, die alle Optionen teilen, daher kann sie hier keine Variantenregeln bekommen.', // review
  'componentProps.variants.cannotGroup': 'Props ist nicht als Typ geschrieben, dem Stacki Variantenregeln hinzufügen kann.', // review
  'componentProps.variants.condition': '{controller}: {options}', // same
  'componentProps.variants.conditional': 'Bedingt', // review
  'componentProps.variants.duplicateOption': 'Es gibt bereits eine Option {value}.', // review
  'componentProps.variants.forbiddenPassed': '{file} übergibt {name} mit {controller} {value}. Ändere zuerst diese Instanz.', // review
  'componentProps.variants.lastOptions': 'Behalte mindestens zwei Optionen.', // review
  'componentProps.variants.missingGroup': 'Keine Variantenregeln werden von {name} gesteuert.', // review
  'componentProps.variants.missingOption': 'Es gibt keine Option {value}.', // review
  'componentProps.variants.missingProp': '{name} gehört nicht zu diesen Variantenregeln.', // review
  'componentProps.variants.noDestructure':
    'Die Komponente liest ihre Eigenschaften nicht über eine einzige Destrukturierung, daher kann die Eigenschaft hier nicht hinzugefügt werden.', // review
  'componentProps.variants.noRuntimeType': 'Der Laufzeittyp der Komponente kann hier keine neue Eigenschaft aufnehmen.', // review
  'componentProps.variants.noType': '{name} hat keinen Typ, der erlaubt werden kann. Gib ihr zuerst einen Typ.', // review
  'componentProps.variants.notAllowedThere': '{name} ist für {value} nicht erlaubt.', // review
  'componentProps.variants.optionInCode': 'Der Code der Komponente verwendet {value} auf eine Weise, die Stacki nicht anpassen kann. Ändere es im Quellcode.', // review
  'componentProps.variants.optionPassed': '{file} übergibt {value} als {name}. Ändere zuerst diese Instanz.', // review
  'componentProps.variants.optionsLimit': 'Eine Eigenschaft kann höchstens {max} Optionen haben.', // review
  'componentProps.variants.readOnly': 'Die von {name} gesteuerten Variantenregeln lassen sich nur im Quellcode ändern.', // review
  'componentProps.variants.reason.nested': 'Verschachtelt', // review
  'componentProps.variants.reason.runtime': 'Laufzeit', // review
  'componentProps.variants.reason.shape': 'Komplex', // review
  'componentProps.variants.reason.shared': 'Geteilt', // review
  'componentProps.variants.removeFallback': '{value} ist der Standard. Mache zuerst eine andere Option zum Standard.', // review
  'componentProps.variants.state.forbidden': 'Ausblenden', // review
  'componentProps.variants.state.optional': 'Anzeigen', // review
  'componentProps.variants.state.required': 'Erforderlich', // review
  'componentProps.variants.switchForbidsAll': 'Keine Option von {name} würde diese Eigenschaft erlauben.', // review
  'componentProps.visibility.combination': 'TypeScript kann diese Kombination nicht ausdrücken. Gib jeder Auswahl eigene Gruppen.', // review
  'componentProps.visibility.hideNeedsCondition':
    'Ausblenden braucht eine Bedingung: Füge eine Auswahl- oder Schalter-Eigenschaft hinzu, nach der ausgeblendet wird.', // review
  'componentProps.visibility.otherwise': 'Sonst {state}', // review
  'componentProps.visibility.shape': 'Jede Gruppe braucht eine Bedingung auf einer Auswahl oder einem Schalter.', // review
  'componentProps.visibility.subject': '{name} ist keine Auswahl und kein Schalter.', // review
  'componentProps.visibility.title': 'Sichtbarkeit', // review
  'componentProps.visibility.when': '{state}, wenn {conditions}', // review
} as const satisfies CatalogOf<MessageKey>;

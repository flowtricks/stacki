// German `elements` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/elements';

export const messages = {
  'elements.astro.comment': 'Kommentar',
  'elements.astro.component': 'Komponente',
  'elements.astro.componentHint': 'Wähle eine im Komponenten-Bereich',
  'elements.astro.condition': 'Bedingung',
  'elements.astro.content': 'Inhalt',
  'elements.astro.expression': 'Ausdruck',
  'elements.astro.fragment': 'Fragment', // same
  'elements.astro.image': 'Bild',
  'elements.astro.loop': 'Schleife',
  'elements.astro.picture': 'Responsives Bild',
  'elements.astro.scriptBlock': 'Skript',
  'elements.astro.slot': 'Slot', // same
  'elements.astro.styleBlock': 'Stil',
  'elements.astro.text': 'Text', // same
  'elements.astroFull.image': 'Astro-Bild',
  'elements.astroFull.picture': 'Astro-Picture',
  'elements.astroFull.scriptBlock': 'Skriptblock',
  'elements.astroFull.styleBlock': 'Stilblock',
  'elements.group.astroAssets': 'Bilder',
  'elements.group.astroBlocks': 'Blöcke',
  'elements.group.astroComposition': 'Komposition',
  'elements.group.astroLogic': 'Logik',
  'elements.group.document': 'Dokument',
  'elements.group.forms': 'Formulare',
  'elements.group.inline': 'Semantik & Inline',
  'elements.group.interactive': 'Interaktiv',
  'elements.group.links': 'Links & Buttons',
  'elements.group.lists': 'Listen',
  'elements.group.media': 'Medien',
  'elements.group.structure': 'Struktur',
  'elements.group.tables': 'Tabellen',
  'elements.group.typography': 'Typografie',
  'elements.panel.clearSearch': 'Suche löschen',
  'elements.panel.empty': 'Keine Elemente passen zu „{query}“.',
  'elements.panel.gridLabel': 'Elemente: {group}',
  'elements.panel.search': 'Elemente suchen',
  'elements.panel.title': 'Elemente hinzufügen',
  'elements.section.astro': 'Astro', // same
  'elements.section.html': 'HTML', // same
  'elements.tag.a': 'Link', // same
  'elements.tag.abbr': 'Abk.',
  'elements.tag.address': 'Adresse',
  'elements.tag.area': 'Bildbereich',
  'elements.tag.article': 'Artikel',
  'elements.tag.aside': 'Seitenleiste',
  'elements.tag.audio': 'Audio', // same
  'elements.tag.b': 'Fett',
  'elements.tag.base': 'Basis-URL',
  'elements.tag.bdi': 'Bidi-Isolierung',
  'elements.tag.bdo': 'Richtung',
  'elements.tag.blockquote': 'Zitat',
  'elements.tag.body': 'Body', // same
  'elements.tag.br': 'Zeilenumbruch',
  'elements.tag.button': 'Button', // same
  'elements.tag.canvas': 'Canvas', // same
  'elements.tag.caption': 'Beschriftung',
  'elements.tag.cite': 'Quellenangabe',
  'elements.tag.code': 'Code', // same
  'elements.tag.col': 'Spalte',
  'elements.tag.colgroup': 'Spaltengr.',
  'elements.tag.data': 'Daten',
  'elements.tag.datalist': 'Datenliste',
  'elements.tag.dd': 'Beschreibung',
  'elements.tag.del': 'Gelöscht',
  'elements.tag.details': 'Details', // same
  'elements.tag.dfn': 'Definition', // same
  'elements.tag.dialog': 'Dialog', // same
  'elements.tag.div': 'Div', // same
  'elements.tag.dl': 'Beschreib.',
  'elements.tag.doctype': 'Doctype', // same
  'elements.tag.dt': 'Begriff',
  'elements.tag.em': 'Betonung',
  'elements.tag.embed': 'Einbettung',
  'elements.tag.fieldset': 'Feldgruppe',
  'elements.tag.figcaption': 'Abb.-Titel',
  'elements.tag.figure': 'Abbildung',
  'elements.tag.footer': 'Footer', // same
  'elements.tag.form': 'Formular',
  'elements.tag.h1': 'Überschrift 1',
  'elements.tag.h2': 'Überschrift 2',
  'elements.tag.h3': 'Überschrift 3',
  'elements.tag.h4': 'Überschrift 4',
  'elements.tag.h5': 'Überschrift 5',
  'elements.tag.h6': 'Überschrift 6',
  'elements.tag.head': 'Head', // same
  'elements.tag.header': 'Header', // same
  'elements.tag.hgroup': 'Überschr.',
  'elements.tag.hr': 'Trennlinie',
  'elements.tag.html': 'HTML', // same
  'elements.tag.i': 'Kursiv',
  'elements.tag.iframe': 'Inline-Frame',
  'elements.tag.img': 'Bild',
  'elements.tag.input': 'Eingabe',
  'elements.tag.ins': 'Eingefügt',
  'elements.tag.kbd': 'Tastatur',
  'elements.tag.label': 'Label', // same
  'elements.tag.legend': 'Legende',
  'elements.tag.li': 'Listeneintrag',
  'elements.tag.link': 'Ressource',
  'elements.tag.main': 'Hauptinhalt',
  'elements.tag.map': 'Image Map', // same
  'elements.tag.mark': 'Hervorhebung',
  'elements.tag.menu': 'Menü',
  'elements.tag.meta': 'Metadaten',
  'elements.tag.meter': 'Anzeige',
  'elements.tag.nav': 'Navigation', // same
  'elements.tag.noscript': 'Ohne Skript',
  'elements.tag.object': 'Objekt',
  'elements.tag.ol': 'Nummeriert',
  'elements.tag.optgroup': 'Optgruppe',
  'elements.tag.option': 'Option', // same
  'elements.tag.output': 'Ausgabe',
  'elements.tag.p': 'Absatz',
  'elements.tag.picture': 'Picture', // same
  'elements.tag.pre': 'Vorformat.',
  'elements.tag.progress': 'Fortschritt',
  'elements.tag.q': 'Inline-Zitat',
  'elements.tag.rp': 'Ruby-Alt.',
  'elements.tag.rt': 'Ruby-Text',
  'elements.tag.ruby': 'Ruby', // same
  'elements.tag.s': 'Durchgestr.',
  'elements.tag.samp': 'Beispiel',
  'elements.tag.script': 'Skript',
  'elements.tag.search': 'Suche',
  'elements.tag.section': 'Section', // same
  'elements.tag.select': 'Auswahl',
  'elements.tag.small': 'Klein',
  'elements.tag.source': 'Quelle',
  'elements.tag.span': 'Span', // same
  'elements.tag.strong': 'Stark betont',
  'elements.tag.style': 'Stil',
  'elements.tag.sub': 'Tiefgestellt',
  'elements.tag.summary': 'Zusammenfassung',
  'elements.tag.sup': 'Hochgestellt',
  'elements.tag.svg': 'SVG', // same
  'elements.tag.table': 'Tabelle',
  'elements.tag.tbody': 'Tabellenkörper',
  'elements.tag.td': 'Zelle',
  'elements.tag.template': 'Vorlage',
  'elements.tag.textarea': 'Textbereich',
  'elements.tag.tfoot': 'Tabellenfuß',
  'elements.tag.th': 'Kopfzelle',
  'elements.tag.thead': 'Tabellenkopf',
  'elements.tag.time': 'Zeit',
  'elements.tag.title': 'Seitentitel',
  'elements.tag.tr': 'Zeile',
  'elements.tag.track': 'Textspur',
  'elements.tag.u': 'Unterstrichen',
  'elements.tag.ul': 'Aufzählungsliste',
  'elements.tag.var': 'Variable', // same
  'elements.tag.video': 'Video', // same
  'elements.tag.wbr': 'Umbruchmöglichkeit',
  'elements.tagFull.abbr': 'Abkürzung',
  'elements.tagFull.bdo': 'Bidi-Überschreibung',
  'elements.tagFull.blockquote': 'Blockzitat',
  'elements.tagFull.colgroup': 'Spaltengruppe',
  'elements.tagFull.del': 'Gelöschter Text',
  'elements.tagFull.dl': 'Beschreibungsliste',
  'elements.tagFull.figcaption': 'Abbildungstitel',
  'elements.tagFull.hgroup': 'Überschriftengruppe',
  'elements.tagFull.ins': 'Eingefügter Text',
  'elements.tagFull.kbd': 'Tastatureingabe',
  'elements.tagFull.link': 'Ressourcen-Link',
  'elements.tagFull.ol': 'Nummerierte Liste',
  'elements.tagFull.optgroup': 'Optionsgruppe',
  'elements.tagFull.pre': 'Vorformatiert',
  'elements.tagFull.rp': 'Ruby-Fallback',
  'elements.tagFull.s': 'Durchgestrichen',
  'elements.tagFull.samp': 'Beispielausgabe',
  'elements.tagFull.small': 'Kleingedrucktes',
  'elements.tagFull.source': 'Medienquelle',
} as const satisfies CatalogOf<MessageKey>;

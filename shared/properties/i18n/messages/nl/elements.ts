// Dutch `elements` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/elements';

export const messages = {
  'elements.astro.comment': 'Opmerking',
  'elements.astro.component': 'Component', // same
  'elements.astro.componentHint': 'Kies er een in het paneel Componenten',
  'elements.astro.condition': 'Voorwaarde',
  'elements.astro.content': 'Inhoud',
  'elements.astro.expression': 'Expressie',
  'elements.astro.fragment': 'Fragment', // same
  'elements.astro.image': 'Afbeelding',
  'elements.astro.loop': 'Lus',
  'elements.astro.picture': 'Responsieve afbeelding',
  'elements.astro.scriptBlock': 'Script', // same
  'elements.astro.slot': 'Slot', // same
  'elements.astro.styleBlock': 'Stijl',
  'elements.astro.text': 'Tekst',
  'elements.astroFull.image': 'Astro-afbeelding',
  'elements.astroFull.picture': 'Astro-picture',
  'elements.astroFull.scriptBlock': 'Scriptblok',
  'elements.astroFull.styleBlock': 'Stijlblok',
  'elements.group.astroAssets': 'Afbeeldingen',
  'elements.group.astroBlocks': 'Blokken',
  'elements.group.astroComposition': 'Compositie',
  'elements.group.astroLogic': 'Logica',
  'elements.group.document': 'Document', // same
  'elements.group.forms': 'Formulieren',
  'elements.group.inline': 'Semantisch en inline',
  'elements.group.interactive': 'Interactief',
  'elements.group.links': 'Links en knoppen',
  'elements.group.lists': 'Lijsten',
  'elements.group.media': 'Media', // same
  'elements.group.structure': 'Structuur',
  'elements.group.tables': 'Tabellen',
  'elements.group.typography': 'Typografie',
  'elements.panel.clearSearch': 'Zoekopdracht wissen',
  'elements.panel.empty': 'Geen elementen gevonden voor “{query}”.',
  'elements.panel.gridLabel': '{group}-elementen',
  'elements.panel.search': 'Elementen zoeken',
  'elements.panel.title': 'Elementen toevoegen',
  'elements.section.astro': 'Astro', // same
  'elements.section.html': 'HTML', // same
  'elements.tag.a': 'Link', // same
  'elements.tag.abbr': 'Afk.',
  'elements.tag.address': 'Adres',
  'elements.tag.area': 'Kaartgebied',
  'elements.tag.article': 'Artikel',
  'elements.tag.aside': 'Zijbalk',
  'elements.tag.audio': 'Audio', // same
  'elements.tag.b': 'Vet',
  'elements.tag.base': 'Basis-URL',
  'elements.tag.bdi': 'Bidi-isolatie',
  'elements.tag.bdo': 'Richting',
  'elements.tag.blockquote': 'Citaat',
  'elements.tag.body': 'Body', // same
  'elements.tag.br': 'Regeleinde',
  'elements.tag.button': 'Knop',
  'elements.tag.canvas': 'Canvas', // same
  'elements.tag.caption': 'Bijschrift',
  'elements.tag.cite': 'Bronvermelding',
  'elements.tag.code': 'Code', // same
  'elements.tag.col': 'Kolom',
  'elements.tag.colgroup': 'Kolomgroep',
  'elements.tag.data': 'Data', // same
  'elements.tag.datalist': 'Datalijst',
  'elements.tag.dd': 'Beschrijving',
  'elements.tag.del': 'Verwijderd',
  'elements.tag.details': 'Details', // same
  'elements.tag.dfn': 'Definitie',
  'elements.tag.dialog': 'Dialoogvenster',
  'elements.tag.div': 'Div', // same
  'elements.tag.dl': 'Beschrijv.',
  'elements.tag.doctype': 'Doctype', // same
  'elements.tag.dt': 'Term', // same
  'elements.tag.em': 'Nadruk',
  'elements.tag.embed': 'Embed', // same
  'elements.tag.fieldset': 'Veldenset',
  'elements.tag.figcaption': 'Bijschrift',
  'elements.tag.figure': 'Figuur',
  'elements.tag.footer': 'Footer', // same
  'elements.tag.form': 'Formulier',
  'elements.tag.h1': 'Kop 1',
  'elements.tag.h2': 'Kop 2',
  'elements.tag.h3': 'Kop 3',
  'elements.tag.h4': 'Kop 4',
  'elements.tag.h5': 'Kop 5',
  'elements.tag.h6': 'Kop 6',
  'elements.tag.head': 'Head', // same
  'elements.tag.header': 'Header', // same
  'elements.tag.hgroup': 'Koppen',
  'elements.tag.hr': 'Scheidingslijn',
  'elements.tag.html': 'HTML', // same
  'elements.tag.i': 'Cursief',
  'elements.tag.iframe': 'Inline frame', // same
  'elements.tag.img': 'Afbeelding',
  'elements.tag.input': 'Invoer',
  'elements.tag.ins': 'Ingevoegd',
  'elements.tag.kbd': 'Toetsenbord',
  'elements.tag.label': 'Label', // same
  'elements.tag.legend': 'Legenda',
  'elements.tag.li': 'Lijstitem',
  'elements.tag.link': 'Bronlink',
  'elements.tag.main': 'Main', // same
  'elements.tag.map': 'Afbeeldingskaart',
  'elements.tag.mark': 'Markering',
  'elements.tag.menu': 'Menu', // same
  'elements.tag.meta': 'Metadata', // same
  'elements.tag.meter': 'Meter', // same
  'elements.tag.nav': 'Navigatie',
  'elements.tag.noscript': 'Geen script',
  'elements.tag.object': 'Object', // same
  'elements.tag.ol': 'Genummerd',
  'elements.tag.optgroup': 'Optiegroep',
  'elements.tag.option': 'Optie',
  'elements.tag.output': 'Uitvoer',
  'elements.tag.p': 'Alinea',
  'elements.tag.picture': 'Picture', // same
  'elements.tag.pre': 'Opgemaakt',
  'elements.tag.progress': 'Voortgang',
  'elements.tag.q': 'Inline citaat',
  'elements.tag.rp': 'Ruby-alt.',
  'elements.tag.rt': 'Ruby-tekst',
  'elements.tag.ruby': 'Ruby', // same
  'elements.tag.s': 'Doorhalen',
  'elements.tag.samp': 'Voorbeeld',
  'elements.tag.script': 'Script', // same
  'elements.tag.search': 'Zoeken',
  'elements.tag.section': 'Sectie',
  'elements.tag.select': 'Selectie',
  'elements.tag.small': 'Klein',
  'elements.tag.source': 'Bron',
  'elements.tag.span': 'Span', // same
  'elements.tag.strong': 'Sterk',
  'elements.tag.style': 'Stijl',
  'elements.tag.sub': 'Subscript', // same
  'elements.tag.summary': 'Samenvatting',
  'elements.tag.sup': 'Superscript', // same
  'elements.tag.svg': 'SVG', // same
  'elements.tag.table': 'Tabel',
  'elements.tag.tbody': 'Tabelbody',
  'elements.tag.td': 'Cel',
  'elements.tag.template': 'Sjabloon',
  'elements.tag.textarea': 'Tekstvak',
  'elements.tag.tfoot': 'Tabelvoet',
  'elements.tag.th': 'Kopcel',
  'elements.tag.thead': 'Tabelkop',
  'elements.tag.time': 'Tijd',
  'elements.tag.title': 'Paginatitel',
  'elements.tag.tr': 'Rij',
  'elements.tag.track': 'Teksttrack',
  'elements.tag.u': 'Onderstrepen',
  'elements.tag.ul': 'Lijst met opsommingstekens',
  'elements.tag.var': 'Variabele',
  'elements.tag.video': 'Video', // same
  'elements.tag.wbr': 'Afbreekmogelijkheid',
  'elements.tagFull.abbr': 'Afkorting',
  'elements.tagFull.bdo': 'Bidi-overschrijving',
  'elements.tagFull.blockquote': 'Citaatblok',
  'elements.tagFull.colgroup': 'Kolomgroep',
  'elements.tagFull.del': 'Verwijderde tekst',
  'elements.tagFull.dl': 'Beschrijvingslijst',
  'elements.tagFull.figcaption': 'Figuurbijschrift',
  'elements.tagFull.hgroup': 'Koppengroep',
  'elements.tagFull.ins': 'Ingevoegde tekst',
  'elements.tagFull.kbd': 'Toetsenbordinvoer',
  'elements.tagFull.link': 'Bronlink',
  'elements.tagFull.ol': 'Genummerde lijst',
  'elements.tagFull.optgroup': 'Optiegroep',
  'elements.tagFull.pre': 'Voorgeformatteerd',
  'elements.tagFull.rp': 'Ruby-fallback',
  'elements.tagFull.s': 'Doorhalen',
  'elements.tagFull.samp': 'Voorbeelduitvoer',
  'elements.tagFull.small': 'Kleine letters',
  'elements.tagFull.source': 'Mediabron',
} as const satisfies CatalogOf<MessageKey>;

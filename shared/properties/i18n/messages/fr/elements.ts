// French `elements` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/elements';

export const messages = {
  'elements.astro.comment': 'Commentaire',
  'elements.astro.component': 'Composant',
  'elements.astro.componentHint': 'Choisissez-en un dans le panneau Composants',
  'elements.astro.condition': 'Condition', // same
  'elements.astro.content': 'Contenu',
  'elements.astro.expression': 'Expression', // same
  'elements.astro.fragment': 'Fragment', // same
  'elements.astro.image': 'Image', // same
  'elements.astro.loop': 'Boucle',
  'elements.astro.picture': 'Image adaptative',
  'elements.astro.scriptBlock': 'Script', // same
  'elements.astro.slot': 'Slot', // same
  'elements.astro.styleBlock': 'Style', // same
  'elements.astro.text': 'Texte',
  'elements.astroFull.image': 'Image Astro',
  'elements.astroFull.picture': 'Picture Astro',
  'elements.astroFull.scriptBlock': 'Bloc de script',
  'elements.astroFull.styleBlock': 'Bloc de style',
  'elements.group.astroAssets': 'Images', // same
  'elements.group.astroBlocks': 'Blocs',
  'elements.group.astroComposition': 'Composition', // same
  'elements.group.astroLogic': 'Logique',
  'elements.group.document': 'Document', // same
  'elements.group.forms': 'Formulaires',
  'elements.group.inline': 'Sémantique et en ligne',
  'elements.group.interactive': 'Interactif',
  'elements.group.links': 'Liens et boutons',
  'elements.group.lists': 'Listes',
  'elements.group.media': 'Médias',
  'elements.group.structure': 'Structure', // same
  'elements.group.tables': 'Tableaux',
  'elements.group.typography': 'Typographie',
  'elements.panel.clearSearch': 'Effacer la recherche',
  'elements.panel.empty': 'Aucun élément ne correspond à « {query} ».',
  'elements.panel.gridLabel': 'Éléments : {group}',
  'elements.panel.search': 'Rechercher des éléments',
  'elements.panel.title': 'Ajouter des éléments',
  'elements.section.astro': 'Astro', // same
  'elements.section.html': 'HTML', // same
  'elements.tag.a': 'Lien',
  'elements.tag.abbr': 'Abrév.',
  'elements.tag.address': 'Adresse',
  'elements.tag.area': 'Zone cliquable',
  'elements.tag.article': 'Article', // same
  'elements.tag.aside': 'Aparté',
  'elements.tag.audio': 'Audio', // same
  'elements.tag.b': 'Gras',
  'elements.tag.base': 'URL de base',
  'elements.tag.bdi': 'Isolat bidirectionnel',
  'elements.tag.bdo': 'Direction', // same
  'elements.tag.blockquote': 'Citation',
  'elements.tag.body': 'Corps',
  'elements.tag.br': 'Saut de ligne',
  'elements.tag.button': 'Bouton',
  'elements.tag.canvas': 'Canvas', // same
  'elements.tag.caption': 'Légende de tableau',
  'elements.tag.cite': 'Référence',
  'elements.tag.code': 'Code', // same
  'elements.tag.col': 'Colonne',
  'elements.tag.colgroup': 'Gr. col.',
  'elements.tag.data': 'Donnée',
  'elements.tag.datalist': 'Liste de données',
  'elements.tag.dd': 'Description', // same
  'elements.tag.del': 'Supprimé',
  'elements.tag.details': 'Détails',
  'elements.tag.dfn': 'Définition',
  'elements.tag.dialog': 'Boîte de dialogue',
  'elements.tag.div': 'Div', // same
  'elements.tag.dl': 'Descript.',
  'elements.tag.doctype': 'Doctype', // same
  'elements.tag.dt': 'Terme',
  'elements.tag.em': 'Emphase',
  'elements.tag.embed': 'Intégration',
  'elements.tag.fieldset': 'Groupe de champs',
  'elements.tag.figcaption': 'Légende',
  'elements.tag.figure': 'Figure', // same
  'elements.tag.footer': 'Pied de page',
  'elements.tag.form': 'Formulaire',
  'elements.tag.h1': 'Titre 1',
  'elements.tag.h2': 'Titre 2',
  'elements.tag.h3': 'Titre 3',
  'elements.tag.h4': 'Titre 4',
  'elements.tag.h5': 'Titre 5',
  'elements.tag.h6': 'Titre 6',
  'elements.tag.head': 'En-tête du document',
  'elements.tag.header': 'En-tête',
  'elements.tag.hgroup': 'Titres',
  'elements.tag.hr': 'Séparateur',
  'elements.tag.html': 'HTML', // same
  'elements.tag.i': 'Italique',
  'elements.tag.iframe': 'Cadre en ligne',
  'elements.tag.img': 'Image', // same
  'elements.tag.input': 'Champ',
  'elements.tag.ins': 'Inséré',
  'elements.tag.kbd': 'Clavier',
  'elements.tag.label': 'Étiquette',
  'elements.tag.legend': 'Légende',
  'elements.tag.li': 'Élément de liste',
  'elements.tag.link': 'Ressource',
  'elements.tag.main': 'Principal',
  'elements.tag.map': 'Carte d’image',
  'elements.tag.mark': 'Surlignage',
  'elements.tag.menu': 'Menu', // same
  'elements.tag.meta': 'Métadonnées',
  'elements.tag.meter': 'Jauge',
  'elements.tag.nav': 'Navigation', // same
  'elements.tag.noscript': 'Sans script',
  'elements.tag.object': 'Objet',
  'elements.tag.ol': 'Numérotée',
  'elements.tag.optgroup': 'Gr. options',
  'elements.tag.option': 'Option', // same
  'elements.tag.output': 'Résultat',
  'elements.tag.p': 'Paragraphe',
  'elements.tag.picture': 'Picture', // same
  'elements.tag.pre': 'Préformaté',
  'elements.tag.progress': 'Progression',
  'elements.tag.q': 'Citation en ligne',
  'elements.tag.rp': 'Repli ruby',
  'elements.tag.rt': 'Texte ruby',
  'elements.tag.ruby': 'Ruby', // same
  'elements.tag.s': 'Barré',
  'elements.tag.samp': 'Exemple',
  'elements.tag.script': 'Script', // same
  'elements.tag.search': 'Recherche',
  'elements.tag.section': 'Section', // same
  'elements.tag.select': 'Sélection',
  'elements.tag.small': 'Petit',
  'elements.tag.source': 'Source', // same
  'elements.tag.span': 'Span', // same
  'elements.tag.strong': 'Gras sémantique',
  'elements.tag.style': 'Style', // same
  'elements.tag.sub': 'Indice',
  'elements.tag.summary': 'Résumé',
  'elements.tag.sup': 'Exposant',
  'elements.tag.svg': 'SVG', // same
  'elements.tag.table': 'Tableau',
  'elements.tag.tbody': 'Corps de tableau',
  'elements.tag.td': 'Cellule',
  'elements.tag.template': 'Modèle',
  'elements.tag.textarea': 'Zone de texte',
  'elements.tag.tfoot': 'Pied de tableau',
  'elements.tag.th': 'Cellule d’en-tête',
  'elements.tag.thead': 'En-tête de tableau',
  'elements.tag.time': 'Heure',
  'elements.tag.title': 'Titre de la page',
  'elements.tag.tr': 'Ligne',
  'elements.tag.track': 'Piste de texte',
  'elements.tag.u': 'Souligné',
  'elements.tag.ul': 'Liste à puces',
  'elements.tag.var': 'Variable', // same
  'elements.tag.video': 'Vidéo',
  'elements.tag.wbr': 'Césure possible',
  'elements.tagFull.abbr': 'Abréviation',
  'elements.tagFull.bdo': 'Forçage bidirectionnel',
  'elements.tagFull.blockquote': 'Citation en bloc',
  'elements.tagFull.colgroup': 'Groupe de colonnes',
  'elements.tagFull.del': 'Texte supprimé',
  'elements.tagFull.dl': 'Liste de descriptions',
  'elements.tagFull.figcaption': 'Légende de figure',
  'elements.tagFull.hgroup': 'Groupe de titres',
  'elements.tagFull.ins': 'Texte inséré',
  'elements.tagFull.kbd': 'Saisie clavier',
  'elements.tagFull.link': 'Lien de ressource',
  'elements.tagFull.ol': 'Liste numérotée',
  'elements.tagFull.optgroup': 'Groupe d’options',
  'elements.tagFull.pre': 'Préformaté',
  'elements.tagFull.rp': 'Repli ruby',
  'elements.tagFull.s': 'Barré',
  'elements.tagFull.samp': 'Sortie d’exemple',
  'elements.tagFull.small': 'Petits caractères',
  'elements.tagFull.source': 'Source média',
} as const satisfies CatalogOf<MessageKey>;

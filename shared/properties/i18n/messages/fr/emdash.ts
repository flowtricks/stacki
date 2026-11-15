// French `emdash` strings (EmDash support). Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/emdash';

export const messages = {
  'emdash.absent.create': 'Créez un site avec le modèle de départ EmDash :',
  'emdash.absent.hint':
    'Stacki détecte EmDash dans le projet : le paquet emdash, son intégration Astro et la collection live _emdash. Ajoutez-les, puis rouvrez les réglages.',
  'emdash.absent.title': 'EmDash n’est pas configuré dans ce projet',
  'emdash.binding.boolean': 'Oui/Non',
  'emdash.binding.data': 'Données',
  'emdash.binding.date': 'Date', // same
  'emdash.binding.file': 'Fichier',
  'emdash.binding.image': 'Image', // same
  'emdash.binding.link': 'Lien',
  'emdash.binding.list': 'Liste',
  'emdash.binding.number': 'Nombre',
  'emdash.binding.reference': 'Référence',
  'emdash.binding.richText': 'Texte enrichi',
  'emdash.binding.text': 'Texte',
  'emdash.button.connected': 'Configuré',
  'emdash.field.required': 'obligatoire',
  'emdash.field.unsupported': 'Type inconnu',
  'emdash.guide.analyze': 'Vérifiez ce qui sera importé (le site local doit être vide) :',
  'emdash.guide.export': 'Exportez le site du client. Cela ne fait que le lire :',
  'emdash.guide.import': 'Importez-le dans votre copie locale :',
  'emdash.guide.login': 'Connectez-vous au site EmDash du client :',
  'emdash.guide.safe':
    'La base de données locale et les envois restent sur cet ordinateur et ne sont jamais déployés. Seul le client modifie son contenu, dans sa propre administration EmDash.',
  'emdash.guide.title': 'Aperçu avec le vrai contenu du client',
  'emdash.hint.definedInEmDash':
    'Les types de contenu et les champs sont définis uniquement dans EmDash. Modifiez-les dans son administration ; Stacki les lit et ne les modifie jamais.',
  'emdash.output.server': 'à la demande (serveur)',
  'emdash.output.static': 'à la compilation (statique)',
  'emdash.output.unknown': 'non défini dans la configuration',
  'emdash.problem.databaseTracked':
    'La base de données locale n’est pas dans .gitignore. Ajoutez-la pour qu’un déploiement n’emporte jamais votre contenu local.',
  'emdash.problem.databaseUnreadable':
    'La base de données locale est illisible. Arrêtez le serveur de développement s’il est en pleine migration, puis rouvrez les réglages.',
  'emdash.problem.noDatabase':
    'Pas encore de base de données locale. Lancez une fois le serveur de développement et terminez la configuration sur /_emdash/admin.',
  'emdash.problem.noIntegration': 'Ajoutez l’intégration emdash() de emdash/astro à astro.config.',
  'emdash.problem.noLiveCollection': 'Enregistrez la collection live _emdash dans src/live.config.ts avec emdashLoader().',
  'emdash.problem.noSchema':
    'Aucun type de contenu pour l’instant. Créez-en dans l’administration EmDash, ou lancez emdash types pour enregistrer un fichier de schéma.',
  'emdash.problem.notInstalled': 'Installez le paquet emdash (npm install emdash).',
  'emdash.problem.schemaUnreadable': 'Le fichier de schéma est illisible. Relancez emdash types.',
  'emdash.problem.staticOutput': 'EmDash lit le contenu à la demande d’une page. Mettez output sur server et ajoutez un adaptateur dans astro.config.',
  'emdash.problem.uploadsTracked': 'Le dossier des envois n’est pas dans .gitignore. Ajoutez-le pour que les médias ne voyagent jamais avec votre code.',
  'emdash.schema.database': 'Lu depuis la base de données locale d’EmDash',
  'emdash.schema.schemaJson': 'Lu depuis .emdash/schema.json',
  'emdash.schema.seed': 'Lu depuis le fichier seed',
  'emdash.status.collections': 'Types de contenu',
  'emdash.status.database': 'Base de données locale',
  'emdash.status.output': 'Les pages sont rendues',
  'emdash.template.collection': 'Type de contenu',
  'emdash.template.create': 'Créer le modèle',
  'emdash.template.empty': 'Aucun type de contenu. Définissez-les d’abord dans EmDash.',
  'emdash.template.layout': 'Mise en page',
  'emdash.template.menu': 'Modèle de page EmDash',
  'emdash.template.noLayout': 'Sans mise en page',
  'emdash.template.noSuchCollection': 'Le projet EmDash n’a aucun type de contenu nommé « {collection} ».',
  'emdash.template.notEmDash': 'Ce projet n’utilise pas encore EmDash.',
  'emdash.template.route': 'Adresse de la page',
  'emdash.template.routeHint': 'Chaque entrée d’EmDash a sa propre page à cette adresse, toujours avec son contenu actuel.',
  'emdash.template.title': 'Nouveau modèle de page EmDash',
  'emdash.title': 'EmDash', // same
  'emdash.unavailable': 'EmDash est lu depuis le dossier du projet ; il n’est donc disponible que dans Stacki Desktop pour l’instant.',
} as const satisfies CatalogOf<MessageKey>;

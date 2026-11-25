// French `cmsBackend` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/cmsBackend';

export const messages = {
  'cmsBackend.body.description': 'Le Markdown de l’entrée, sous son frontmatter.',
  'cmsBackend.body.title': 'Corps',
  'cmsBackend.config.collectionExists': 'Une collection nommée « {name} » existe déjà.',
  'cmsBackend.config.collectionsNotClosed': 'L’export collections de la configuration du contenu n’est pas fermé.',
  'cmsBackend.config.nameUsed': '« {name} » est déjà utilisé dans la configuration du contenu.',
  'cmsBackend.config.noCollections': 'Stacki n’a pas trouvé `export const collections = {{ … }}` dans la configuration du contenu.',
  'cmsBackend.config.notListed': '{collection} ne figure pas dans les collections de la configuration du contenu.',
  'cmsBackend.config.tooLarge': 'La configuration du contenu est trop volumineuse pour être modifiée ici.',
  'cmsBackend.connection.cannotTest': 'Cette connexion ne peut pas être testée.',
  'cmsBackend.content.unreadable': 'La collection de contenu n’a pas pu être lue.',
  'cmsBackend.data.parseFailed': '{file} n’a pas pu être analysé — {detail}',
  'cmsBackend.data.readFailed': 'Impossible de lire {file} — {detail}',
  'cmsBackend.data.tooLarge': '{file} est trop volumineux pour être modifié ici.',
  'cmsBackend.data.unreadableFormat': 'Stacki ne sait pas encore lire les fichiers de données {extension}.',
  'cmsBackend.entries.customLoader':
    '{collection} est construite par un loader de ce projet et n’est pas stockée dans un fichier. Ses entrées sont reconstruites à chaque synchronisation : tout ce qui serait écrit ici serait écrasé.', // review
  'cmsBackend.entries.idsGenerated':
    '{collection} construit ses ids dans le loader, à partir des champs de chaque entrée. Les ids affichés sont les chemins de fichier, et non ce que référencent les autres collections.', // review
  'cmsBackend.entries.parserNote':
    '{collection} est analysée par une fonction de la configuration du contenu avant qu’Astro ne la voie. Les champs absents du fichier ont été créés par cet analyseur : ils s’affichent, mais en modifier un ici n’aurait aucun effet.', // review
  'cmsBackend.entry.generated': '{collection} construit ses ids dans son loader : renommer un fichier ne change donc pas l’id.', // review
  'cmsBackend.entry.noId': 'Rien dans {file} n’indique l’id de cette entrée.',
  'cmsBackend.entry.parsed': '{collection} est analysé par une fonction de la configuration du contenu : ses ids ne sont donc pas dans le fichier.', // review
  'cmsBackend.fieldName.empty': 'Nommez le champ.',
  'cmsBackend.fieldName.invalid': 'Un nom de champ commence par une lettre et contient des lettres, des chiffres, - et _.',
  'cmsBackend.fieldName.tooLong': { one: 'Un nom de champ compte au plus {count} caractère.', other: 'Un nom de champ compte au plus {count} caractères.' },
  'cmsBackend.media.bodyNotBytes': 'L’hôte a envoyé un corps qui n’est pas composé d’octets.',
  'cmsBackend.media.bodyTooLarge': 'L’hôte a envoyé plus de {size} Mo.',
  'cmsBackend.media.bunnyNoZone': 'Ce compte Bunny n’a aucune storage zone nommée {name}.',
  'cmsBackend.media.bunnyNotList': 'Bunny Storage a envoyé une liste qui n’en est pas une.',
  'cmsBackend.media.bunnyRefusedKey':
    'Bunny a refusé cette clé d’API. Utilisez la clé d’API du compte (Account settings → API key), pas le mot de passe d’une storage zone.',
  'cmsBackend.media.bunnyUnreadable': 'Bunny Storage a envoyé une liste illisible.',
  'cmsBackend.media.cloudflareInactive': 'Ce jeton Cloudflare n’est pas actif. Créez-en un nouveau et collez-le à nouveau.',
  'cmsBackend.media.cloudflareNoToken': 'Cloudflare n’a pas indiqué de quel jeton il s’agit.',
  'cmsBackend.media.cloudflareRefused': 'Cloudflare a refusé la requête.{detail}',
  'cmsBackend.media.fileGone': 'Ce fichier n’existe plus.',
  'cmsBackend.media.fileTooLarge': '{name} dépasse {size} Mo.',
  'cmsBackend.media.missingInFolder': '{name} n’est plus dans ce dossier. Actualisez et réessayez.',
  'cmsBackend.media.nameExists': 'Un élément porte déjà ce nom.',
  'cmsBackend.media.nestedTooDeep': 'Ce dossier est trop imbriqué pour être modifié ici.',
  'cmsBackend.media.status.limited': 'L’hôte limite les requêtes. Réessayez dans un instant.{detail}',
  'cmsBackend.media.status.notFound': 'L’hôte n’a ni ce bucket, ni cette zone, ni ce fichier.{detail}',
  'cmsBackend.media.status.refused': 'L’hôte a refusé la requête ({status}).{detail}',
  'cmsBackend.media.status.refusedKeys': 'L’hôte a refusé les clés. Vérifiez-les, ainsi que leur droit de lire et d’écrire dans ce bucket.{detail}', // review
  'cmsBackend.media.status.server': 'L’hôte a rencontré un problème ({status}). Réessayez dans un instant.{detail}',
  'cmsBackend.media.tooManyFiles': 'Ce dossier contient plus de {count} fichiers ; modifiez-le dans le tableau de bord de l’hôte.',
  'cmsBackend.media.tooManyFilesBunny': 'Ce dossier contient plus de {count} fichiers ; modifiez-le dans le tableau de bord de Bunny.',
  'cmsBackend.media.unreachable': 'Impossible de joindre {host} : {reason}',
  'cmsBackend.network.failed': 'La requête au CMS a échoué.',
  'cmsBackend.payload.noDrafts': '{collection} n’a aucun brouillon à publier ou à abandonner.',
  'cmsBackend.payload.noUpload': 'Payload n’a aucune collection d’envoi visible pour ce compte.',
  'cmsBackend.payload.notOrdered': 'Les collections Payload ne sont pas ordonnées.',
  'cmsBackend.sample.answered': 'Cette adresse a répondu {status}.',
  'cmsBackend.sample.answeredWith': 'Cette adresse a répondu {status} : {detail}',
  'cmsBackend.sample.notFound': 'Rien n’a été trouvé à cette adresse (404).',
  'cmsBackend.sample.refused': 'Cette adresse a refusé la requête ({status}). Vérifiez l’en-tête et sa valeur.',
  'cmsBackend.sample.tooLarge': 'Cette réponse dépasse {size} Mo, ce qui est trop pour un échantillon.',
  'cmsBackend.sanity.answered': 'Sanity a répondu {status}.',
  'cmsBackend.sanity.noKeyRole':
    'Votre rôle dans ce projet Sanity ne permet pas de créer des clés d’API (Administrateur ou Développeur le peuvent). Demandez-en une à un administrateur, puis collez-la avec l’option de clé à côté du bouton de connexion.', // review
  'cmsBackend.sanity.signInFailed': 'La connexion à Sanity a échoué.',
  'cmsBackend.sanity.signInGone': 'Cette connexion à Sanity n’est plus en cours.',
  'cmsBackend.sanity.signInTimedOut': 'La connexion à Sanity a expiré.',
  'cmsBackend.sanity.someone': 'Quelqu’un',
  'cmsBackend.schema.collectionExists': 'Une collection nommée {name} existe déjà.',
  'cmsBackend.schema.fieldExists': 'Un champ nommé {name} existe déjà.',
  'cmsBackend.schema.fieldsChanged': 'Les champs ont changé depuis leur affichage. Rouvrez les réglages.',
  'cmsBackend.schema.imageByHand': 'Ajoutez `image` à la main dans la fonction du schéma, puis ajoutez le champ.',
  'cmsBackend.schema.noField': 'Il n’y a pas de champ {name}.',
  'cmsBackend.schema.noImageSchema': 'Cette collection n’a pas de schéma où ajouter un champ image.',
  'cmsBackend.schema.noObject': '{collection} n’a aucun schéma z.object({{ … }}) à modifier dans la configuration.',
  'cmsBackend.schema.notCollection': '{name} n’est pas une collection de la configuration du contenu.',
  'cmsBackend.schema.tooComplex': '{name} est écrit sous forme de méthode ou de très longue chaîne ; modifiez-le dans la configuration.',
  'cmsBackend.slug.empty': 'Un slug doit contenir au moins une lettre ou un chiffre',
  'cmsBackend.slug.saved': 'Enregistré sous « {slug} »',
  'cmsBackend.slug.taken': 'Un autre élément utilise déjà ce slug',
  'cmsBackend.slug.tooLong': { one: '{count} caractère au maximum', other: '{count} caractères au maximum' },
} as const satisfies CatalogOf<MessageKey>;

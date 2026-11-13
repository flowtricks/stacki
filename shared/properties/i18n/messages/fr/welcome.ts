// French `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Téléchargement…',
  'welcome.clone.downloading': 'Téléchargement du dépôt…',
  'welcome.clone.hint': 'Choisissez ensuite un dossier. Stacki télécharge une nouvelle copie locale avec son historique Git.',
  'welcome.clone.invalid': 'Saisissez un dépôt sous la forme propriétaire/nom.',
  'welcome.clone.submit': 'Choisir le dossier et télécharger',
  'welcome.clone.title': 'Ouvrir depuis GitHub',
  'welcome.creating': 'Création…',
  'welcome.hero.moreOpen': 'Autres façons d’ouvrir un projet',
  'welcome.hero.moreStart': 'Autres façons de démarrer un projet',
  'welcome.hero.openFolder': 'Ouvrir depuis un dossier',
  'welcome.hero.openGitHub': 'Ouvrir depuis GitHub',
  'welcome.hero.startAstro': 'Démarrer depuis Astro',
  'welcome.hero.startLumos': 'Démarrer depuis Lumos',
  'welcome.packageManager': 'Gestionnaire de paquets',
  'welcome.project.ai': 'Ajouter les fichiers d’agent IA',
  'welcome.project.git': 'Initialiser un nouveau dépôt git',
  'welcome.project.install': 'Installer les dépendances',
  'welcome.project.question': 'Comment voulez-vous démarrer votre nouveau projet ?',
  'welcome.project.starting': 'Démarrage…',
  'welcome.project.submit': 'Créer le projet',
  'welcome.project.title': 'Nouveau projet Astro',
  'welcome.project.tryAgain': 'Réessayer',
  'welcome.projectCreated': 'Projet créé',
  'welcome.recent.remove': 'Retirer des projets récents',
  'welcome.siteCreated': 'Site créé',
  'welcome.siteName': 'Nom du site',
  'welcome.starter.note': 'Exécute {command}, puis démarre un historique git à part — ainsi, le publier plus tard publie votre site, pas un fork du starter.',
  'welcome.starter.noteWithManager':
    'Exécute {command}, l’installe avec {manager}, puis démarre un historique git à part — ainsi, le publier plus tard publie votre site, pas un fork du starter.',
  'welcome.starter.submit': 'Créer le site',
  'welcome.starter.title': 'Démarrer depuis Lumos',
  'welcome.starter.unfinished': 'Le starter ne s’est pas terminé.',
  'welcome.template.basics.hint': 'Un projet de départ simple et utile',
  'welcome.template.basics.label': 'Basique',
  'welcome.template.blog.hint': 'Collections de contenu et routage des articles',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Rien que l’essentiel',
  'welcome.template.minimal.label': 'Vide',
  'welcome.template.starlight.hint': 'Le thème de documentation d’Astro',
  'welcome.template.starlight.label': 'Docs (Starlight)', // same
  'welcome.working': 'En cours',
} as const satisfies CatalogOf<MessageKey>;

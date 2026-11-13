// German `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Wird heruntergeladen …',
  'welcome.clone.downloading': 'Repository wird heruntergeladen …',
  'welcome.clone.hint': 'Wähle als Nächstes einen Ordner. Stacki lädt eine neue lokale Kopie mit ihrem Git-Verlauf herunter.',
  'welcome.clone.invalid': 'Gib ein Repository als Eigentümer/Name ein.',
  'welcome.clone.submit': 'Ordner wählen und herunterladen',
  'welcome.clone.title': 'Von GitHub öffnen',
  'welcome.creating': 'Wird erstellt …',
  'welcome.hero.moreOpen': 'Weitere Möglichkeiten, ein Projekt zu öffnen',
  'welcome.hero.moreStart': 'Weitere Möglichkeiten, ein Projekt zu starten',
  'welcome.hero.openFolder': 'Aus Ordner öffnen',
  'welcome.hero.openGitHub': 'Von GitHub öffnen',
  'welcome.hero.startAstro': 'Mit Astro starten',
  'welcome.hero.startLumos': 'Mit Lumos starten',
  'welcome.packageManager': 'Paketmanager',
  'welcome.project.ai': 'KI-Agent-Dateien hinzufügen',
  'welcome.project.git': 'Neues Git-Repository initialisieren',
  'welcome.project.install': 'Abhängigkeiten installieren',
  'welcome.project.question': 'Wie möchtest du dein neues Projekt starten?',
  'welcome.project.starting': 'Wird gestartet …',
  'welcome.project.submit': 'Projekt erstellen',
  'welcome.project.title': 'Neues Astro-Projekt',
  'welcome.project.tryAgain': 'Erneut versuchen',
  'welcome.projectCreated': 'Projekt erstellt',
  'welcome.recent.remove': 'Aus zuletzt verwendeten Projekten entfernen',
  'welcome.siteCreated': 'Website erstellt',
  'welcome.siteName': 'Name der Website',
  'welcome.starter.note':
    'Führt {command} aus und startet dann einen eigenen Git-Verlauf — so veröffentlichst du später deine Website, nicht einen Fork des Starters.',
  'welcome.starter.noteWithManager':
    'Führt {command} aus, installiert es mit {manager} und startet dann einen eigenen Git-Verlauf — so veröffentlichst du später deine Website, nicht einen Fork des Starters.',
  'welcome.starter.submit': 'Website erstellen',
  'welcome.starter.title': 'Mit Lumos starten',
  'welcome.starter.unfinished': 'Der Starter wurde nicht abgeschlossen.',
  'welcome.template.basics.hint': 'Ein einfaches, hilfreiches Startprojekt',
  'welcome.template.basics.label': 'Grundlagen',
  'welcome.template.blog.hint': 'Inhaltssammlungen und Beitragsrouting',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Nur das Wesentliche',
  'welcome.template.minimal.label': 'Leer',
  'welcome.template.starlight.hint': 'Astros Dokumentationsdesign',
  'welcome.template.starlight.label': 'Docs (Starlight)', // same
  'welcome.working': 'Wird ausgeführt',
} as const satisfies CatalogOf<MessageKey>;

// Dutch `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Downloaden…',
  'welcome.clone.downloading': 'Repository downloaden…',
  'welcome.clone.hint': 'Kies hierna een map. Stacki downloadt een nieuwe lokale kopie met de Git-geschiedenis.',
  'welcome.clone.invalid': 'Voer een repository in als eigenaar/naam.',
  'welcome.clone.submit': 'Map kiezen en downloaden',
  'welcome.clone.title': 'Openen vanaf GitHub',
  'welcome.creating': 'Maken…',
  'welcome.hero.moreOpen': 'Meer manieren om een project te openen',
  'welcome.hero.moreStart': 'Meer manieren om een project te starten',
  'welcome.hero.openFolder': 'Openen vanuit map',
  'welcome.hero.openGitHub': 'Openen vanaf GitHub',
  'welcome.hero.startAstro': 'Starten met Astro',
  'welcome.hero.startLumos': 'Starten met Lumos',
  'welcome.packageManager': 'Pakketbeheerder',
  'welcome.project.ai': 'AI-agentbestanden toevoegen',
  'welcome.project.git': 'Een nieuwe Git-repository initialiseren',
  'welcome.project.install': 'Afhankelijkheden installeren',
  'welcome.project.question': 'Hoe wil je je nieuwe project starten?',
  'welcome.project.starting': 'Starten…',
  'welcome.project.submit': 'Project maken',
  'welcome.project.title': 'Nieuw Astro-project',
  'welcome.project.tryAgain': 'Opnieuw proberen',
  'welcome.projectCreated': 'Project gemaakt',
  'welcome.recent.remove': 'Uit recente projecten verwijderen',
  'welcome.siteCreated': 'Site gemaakt',
  'welcome.siteName': 'Sitenaam',
  'welcome.starter.note':
    'Voert {command} uit en begint daarna een eigen Git-geschiedenis, zodat publiceren later jouw site publiceert en geen fork van de starter.',
  'welcome.starter.noteWithManager':
    'Voert {command} uit, installeert het met {manager} en begint daarna een eigen Git-geschiedenis, zodat publiceren later jouw site publiceert en geen fork van de starter.',
  'welcome.starter.submit': 'Site maken',
  'welcome.starter.title': 'Starten met Lumos',
  'welcome.starter.unfinished': 'De starter is niet voltooid.',
  'welcome.template.basics.hint': 'Een eenvoudig, handig startproject',
  'welcome.template.basics.label': 'Basis',
  'welcome.template.blog.hint': 'Inhoudscollecties en postroutes',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Alleen de essentie',
  'welcome.template.minimal.label': 'Leeg',
  'welcome.template.starlight.hint': 'Het documentatiethema van Astro',
  'welcome.template.starlight.label': 'Documentatie (Starlight)',
  'welcome.working': 'Bezig',
} as const satisfies CatalogOf<MessageKey>;

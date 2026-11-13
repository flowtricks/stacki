// English `welcome` strings: the source of truth for every key beginning `welcome.` (docs/i18n.md). Alphabetical.
// Each key is a stable dotted name; the other four locales hold exactly these keys, checked by the compiler and the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';

export const messages = {
  'welcome.clone.busy': 'Downloading…',
  'welcome.clone.downloading': 'Downloading repository…',
  'welcome.clone.hint': 'Choose a folder next. Stacki downloads a new local copy with its Git history.',
  'welcome.clone.invalid': 'Enter a repository as owner/name.',
  'welcome.clone.submit': 'Choose folder and download',
  'welcome.clone.title': 'Open from GitHub',
  'welcome.creating': 'Creating…',
  'welcome.hero.moreOpen': 'More ways to open a project',
  'welcome.hero.moreStart': 'More ways to start a project',
  'welcome.hero.openFolder': 'Open from folder',
  'welcome.hero.openGitHub': 'Open from GitHub',
  'welcome.hero.startAstro': 'Start from Astro',
  'welcome.hero.startLumos': 'Start from Lumos',
  'welcome.packageManager': 'Package manager',
  'welcome.project.ai': 'Add AI agent files',
  'welcome.project.git': 'Initialize a new git repository',
  'welcome.project.install': 'Install dependencies',
  'welcome.project.question': 'How would you like to start your new project?',
  'welcome.project.starting': 'Starting…',
  'welcome.project.submit': 'Create Project',
  'welcome.project.title': 'New Astro Project',
  'welcome.project.tryAgain': 'Try again',
  'welcome.projectCreated': 'Project created',
  'welcome.recent.remove': 'Remove from recent projects',
  'welcome.siteCreated': 'Site created',
  'welcome.siteName': 'Site name',
  'welcome.starter.note': 'Runs {command}, then starts a git history of its own — so publishing it later publishes your site, not a fork of the starter.',
  'welcome.starter.noteWithManager':
    'Runs {command}, installs it with {manager}, then starts a git history of its own — so publishing it later publishes your site, not a fork of the starter.',
  'welcome.starter.submit': 'Create site',
  'welcome.starter.title': 'Start from Lumos',
  'welcome.starter.unfinished': 'The starter did not finish.',
  'welcome.template.basics.hint': 'A basic, helpful starter project',
  'welcome.template.basics.label': 'Basics',
  'welcome.template.blog.hint': 'Content collections and post routing',
  'welcome.template.blog.label': 'Blog',
  'welcome.template.minimal.hint': 'Nothing but the essentials',
  'welcome.template.minimal.label': 'Empty',
  'welcome.template.starlight.hint': 'Astro’s documentation theme',
  'welcome.template.starlight.label': 'Docs (Starlight)',
  'welcome.working': 'Working',
} as const satisfies CatalogOf<`welcome.${string}`>;

export type MessageKey = keyof typeof messages;

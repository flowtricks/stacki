// Italian `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Download in corso…',
  'welcome.clone.downloading': 'Download del repository in corso…',
  'welcome.clone.hint': 'Scegli prima una cartella. Stacki scarica una nuova copia locale con la sua cronologia Git.',
  'welcome.clone.invalid': 'Inserisci un repository come owner/name.',
  'welcome.clone.submit': 'Scegli cartella e scarica',
  'welcome.clone.title': 'Apri da GitHub',
  'welcome.creating': 'Creazione in corso…',
  'welcome.hero.moreOpen': 'Altri modi per aprire un progetto',
  'welcome.hero.moreStart': 'Altri modi per iniziare un progetto',
  'welcome.hero.openFolder': 'Apri da cartella',
  'welcome.hero.openGitHub': 'Apri da GitHub',
  'welcome.hero.startAstro': 'Inizia da Astro',
  'welcome.hero.startLumos': 'Inizia da Lumos',
  'welcome.packageManager': 'Gestore di pacchetti',
  'welcome.project.ai': 'Aggiungi i file per gli agenti AI',
  'welcome.project.git': 'Inizializza un nuovo repository git',
  'welcome.project.install': 'Installa le dipendenze',
  'welcome.project.question': 'Come vuoi iniziare il tuo nuovo progetto?',
  'welcome.project.starting': 'Avvio in corso…',
  'welcome.project.submit': 'Crea progetto',
  'welcome.project.title': 'Nuovo progetto Astro',
  'welcome.project.tryAgain': 'Riprova',
  'welcome.projectCreated': 'Progetto creato',
  'welcome.recent.remove': 'Rimuovi dai progetti recenti',
  'welcome.siteCreated': 'Sito creato',
  'welcome.siteName': 'Nome del sito',
  'welcome.starter.note':
    'Esegue {command}, poi avvia una cronologia git propria: così pubblicarlo in seguito pubblica il tuo sito, non un fork dello starter.',
  'welcome.starter.noteWithManager':
    'Esegue {command}, lo installa con {manager}, poi avvia una cronologia git propria: così pubblicarlo in seguito pubblica il tuo sito, non un fork dello starter.',
  'welcome.starter.submit': 'Crea sito',
  'welcome.starter.title': 'Inizia da Lumos',
  'welcome.starter.unfinished': 'Lo starter non è stato completato.',
  'welcome.template.basics.hint': 'Un progetto iniziale semplice e utile',
  'welcome.template.basics.label': 'Base',
  'welcome.template.blog.hint': 'Collezioni di contenuti e routing dei post',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Solo l’essenziale',
  'welcome.template.minimal.label': 'Vuoto',
  'welcome.template.starlight.hint': 'Il tema per la documentazione di Astro',
  'welcome.template.starlight.label': 'Documentazione (Starlight)',
  'welcome.working': 'Elaborazione in corso',
} as const satisfies CatalogOf<MessageKey>;

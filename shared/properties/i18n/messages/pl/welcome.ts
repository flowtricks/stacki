// Polish `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Pobieranie…',
  'welcome.clone.downloading': 'Pobieranie repozytorium…',
  'welcome.clone.hint': 'Następnie wybierz folder. Stacki pobiera nową lokalną kopię wraz z historią Git.',
  'welcome.clone.invalid': 'Wpisz repozytorium jako właściciel/nazwa.',
  'welcome.clone.submit': 'Wybierz folder i pobierz',
  'welcome.clone.title': 'Otwórz z GitHub',
  'welcome.creating': 'Tworzenie…',
  'welcome.hero.moreOpen': 'Więcej sposobów otwarcia projektu',
  'welcome.hero.moreStart': 'Więcej sposobów rozpoczęcia projektu',
  'welcome.hero.openFolder': 'Otwórz z folderu',
  'welcome.hero.openGitHub': 'Otwórz z GitHub',
  'welcome.hero.startAstro': 'Zacznij od Astro',
  'welcome.hero.startLumos': 'Zacznij od Lumos',
  'welcome.packageManager': 'Menedżer pakietów',
  'welcome.project.ai': 'Dodaj pliki agenta AI',
  'welcome.project.git': 'Zainicjuj nowe repozytorium git',
  'welcome.project.install': 'Zainstaluj zależności',
  'welcome.project.question': 'Jak chcesz zacząć nowy projekt?',
  'welcome.project.starting': 'Uruchamianie…',
  'welcome.project.submit': 'Utwórz projekt',
  'welcome.project.title': 'Nowy projekt Astro',
  'welcome.project.tryAgain': 'Spróbuj ponownie',
  'welcome.projectCreated': 'Projekt utworzony',
  'welcome.recent.remove': 'Usuń z ostatnich projektów',
  'welcome.siteCreated': 'Witryna utworzona',
  'welcome.siteName': 'Nazwa witryny',
  'welcome.starter.note':
    'Uruchamia {command}, a potem zaczyna własną historię git — dzięki temu późniejsze opublikowanie publikuje Twoją witrynę, a nie fork startera.',
  'welcome.starter.noteWithManager':
    'Uruchamia {command}, instaluje ją za pomocą {manager}, a potem zaczyna własną historię git — dzięki temu późniejsze opublikowanie publikuje Twoją witrynę, a nie fork startera.',
  'welcome.starter.submit': 'Utwórz witrynę',
  'welcome.starter.title': 'Zacznij od Lumos',
  'welcome.starter.unfinished': 'Starter nie dokończył pracy.',
  'welcome.template.basics.hint': 'Prosty, przydatny projekt startowy',
  'welcome.template.basics.label': 'Podstawowy',
  'welcome.template.blog.hint': 'Kolekcje treści i routing wpisów',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Tylko to, co niezbędne',
  'welcome.template.minimal.label': 'Pusty',
  'welcome.template.starlight.hint': 'Motyw dokumentacji Astro',
  'welcome.template.starlight.label': 'Dokumentacja (Starlight)',
  'welcome.working': 'Pracuję',
} as const satisfies CatalogOf<MessageKey>;

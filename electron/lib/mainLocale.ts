// The main process's own `translate` (docs/i18n-playbook.md, "Main process"): the application menu, native dialogs and updater
// text cannot use the renderer's provider, so they read the same catalogs through the same pure functions.
//
// Only the namespaces main needs are loaded (`menu`, `dialog`, `error`, plus `assets` and `pages` for the refusals their handlers send to the renderer), one locale at a time, and English is bundled as the
// fallback so a menu can be built before any import finishes. The language comes from the stored preference (the renderer's
// choice, mirrored over `locale:set`) or, for "System default", the operating system's languages.
import type { Described } from '../../shared/properties/i18n/messageRef';
import { assert } from '../../shared/core/assert';
import { createTranslator, parseCatalog, type Catalog, type CatalogIssue, type MessageParams } from '../../shared/core/i18n/catalog';
import { LOCALE_DEFAULT, type Locale } from '../../shared/core/i18n/locales';
import { messages as assetsEnglish } from '../../shared/properties/i18n/messages/en/assets';
import { messages as dialogEnglish } from '../../shared/properties/i18n/messages/en/dialog';
import { messages as errorEnglish } from '../../shared/properties/i18n/messages/en/error';
import { messages as menuEnglish } from '../../shared/properties/i18n/messages/en/menu';
import { messages as pagesEnglish } from '../../shared/properties/i18n/messages/en/pages';

/** Every key a main-process caller may use: the English `assets`, `dialog`, `error`, `menu` and `pages` namespaces. */
const ENGLISH = { ...assetsEnglish, ...dialogEnglish, ...errorEnglish, ...menuEnglish, ...pagesEnglish } as const;
export type MainMessageKey = keyof typeof ENGLISH;

export interface MainLocale {
  readonly locale: Locale;
  readonly translate: (key: MainMessageKey, params?: MessageParams) => string;
}

/** Imports one locale's main namespaces, each a module with a `messages` export. Replaced by tests. */
export type MainCatalogImporter = (locale: Exclude<Locale, 'en'>) => Promise<readonly unknown[]>;

const SHIPPED_IMPORTER: MainCatalogImporter = async (locale) => {
  switch (locale) {
    case 'es':
      return Promise.all([
        import('../../shared/properties/i18n/messages/es/assets'),
        import('../../shared/properties/i18n/messages/es/dialog'),
        import('../../shared/properties/i18n/messages/es/error'),
        import('../../shared/properties/i18n/messages/es/menu'),
        import('../../shared/properties/i18n/messages/es/pages'),
      ]);
    case 'fr':
      return Promise.all([
        import('../../shared/properties/i18n/messages/fr/assets'),
        import('../../shared/properties/i18n/messages/fr/dialog'),
        import('../../shared/properties/i18n/messages/fr/error'),
        import('../../shared/properties/i18n/messages/fr/menu'),
        import('../../shared/properties/i18n/messages/fr/pages'),
      ]);
    case 'de':
      return Promise.all([
        import('../../shared/properties/i18n/messages/de/assets'),
        import('../../shared/properties/i18n/messages/de/dialog'),
        import('../../shared/properties/i18n/messages/de/error'),
        import('../../shared/properties/i18n/messages/de/menu'),
        import('../../shared/properties/i18n/messages/de/pages'),
      ]);
    case 'pt-BR':
      return Promise.all([
        import('../../shared/properties/i18n/messages/ptBR/assets'),
        import('../../shared/properties/i18n/messages/ptBR/dialog'),
        import('../../shared/properties/i18n/messages/ptBR/error'),
        import('../../shared/properties/i18n/messages/ptBR/menu'),
        import('../../shared/properties/i18n/messages/ptBR/pages'),
      ]);
    default: {
      const exhaustive: never = locale;
      return exhaustive;
    }
  }
};

function warnMain(issue: CatalogIssue): void {
  console.warn(`[i18n] ${issue.kind} ${issue.locale} ${issue.key}${issue.kind === 'bad-message' ? `: ${issue.reason}` : ''}`);
}

/** English, available at once: the menu is built from this before any other language has loaded. */
export const MAIN_ENGLISH: MainLocale = {
  locale: LOCALE_DEFAULT,
  translate: createTranslator({ locale: LOCALE_DEFAULT, catalog: ENGLISH, fallback: ENGLISH, onIssue: warnMain }),
};

/**
 * The main-process translator for a locale. A language that cannot be loaded or parsed is an expected failure, not a crash: the
 * answer is English and the console says why, so a damaged install still has a working menu.
 */
export async function loadMainLocale(locale: Locale, importer: MainCatalogImporter = SHIPPED_IMPORTER): Promise<MainLocale> {
  if (locale === 'en') {
    return MAIN_ENGLISH;
  }
  let modules: readonly unknown[];
  try {
    modules = await importer(locale);
  } catch (failure: unknown) {
    console.warn(`[i18n] could not load the ${locale} main catalogs: ${String(failure)}`);
    return MAIN_ENGLISH;
  }
  const merged: Record<string, Catalog[string]> = {};
  for (const loaded of modules) {
    const candidate = typeof loaded === 'object' && loaded !== null && 'messages' in loaded ? loaded.messages : undefined;
    const parsed = parseCatalog(candidate);
    if (!parsed.ok) {
      console.warn(`[i18n] the ${locale} main catalogs are invalid: ${parsed.error.message}`);
      return MAIN_ENGLISH;
    }
    Object.assign(merged, parsed.value);
  }
  assert(Object.keys(merged).length > 0, 'loadMainLocale: a loaded language has messages');
  return { locale, translate: createTranslator({ locale, catalog: merged, fallback: ENGLISH, onIssue: warnMain }) };
}

let current: MainLocale = MAIN_ENGLISH;

/** Makes `locale` the language `translateMain` speaks. Called when the process starts and when the person changes language. */
export function setMainLocale(locale: MainLocale): void {
  current = locale;
}

/** The active main-process language, for `Intl` formatting and for comparing with a new choice. */
export function activeMainLocale(): Locale {
  return current.locale;
}

/** `translateMain('menu.file.title')`: the text for a key in the language the person chose, English until it has loaded. */
export function translateMain(key: MainMessageKey, params?: MessageParams): string {
  return current.translate(key, params);
}

/** Whether `key` is one main loads; a reference from `shared/` can name any namespace, and only these can be translated here. */
function isMainMessageKey(key: string): key is MainMessageKey {
  return Object.hasOwn(ENGLISH, key);
}

/**
 * The sentence a `shared/` or project-layer failure describes (`{ message, messageRef }`), in the language main speaks: translated when its
 * key is one main loads and its parameters fit, otherwise the English `message` it always carried.
 */
export function translateMainDescribed(problem: Described): string {
  const reference = problem.messageRef;
  if (reference === undefined || !isMainMessageKey(reference.key)) {
    return problem.message;
  }
  try {
    return current.translate(reference.key, reference.params);
  } catch {
    return problem.message;
  }
}

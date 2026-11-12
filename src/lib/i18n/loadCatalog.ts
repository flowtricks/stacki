// Loads a language's catalog on demand (docs/i18n.md). English is the source and is bundled with
// the app; every other language is its own chunk, fetched only when someone's language is not
// English, so an English user downloads nothing extra. A failed or corrupt chunk is a value, not a
// crash: the interface stays in English.
import { err, ok, type AppError, type Result } from '../../../shared/core/result';
import { parseCatalog, type Catalog } from '../../../shared/core/i18n/catalog';
import type { Locale } from '../../../shared/core/i18n/locales';
import { messages as english } from '../../../shared/properties/i18n/messages/en';

export type CatalogImporters = Readonly<Record<Locale, () => Promise<unknown>>>;

/** The importers the app ships. Each `import()` is a split point the bundler turns into a chunk. */
const SHIPPED_IMPORTERS: CatalogImporters = {
  en: () => Promise.resolve(english),
  es: () => import('../../../shared/properties/i18n/messages/es'),
  fr: () => import('../../../shared/properties/i18n/messages/fr'),
  de: () => import('../../../shared/properties/i18n/messages/de'),
  'pt-BR': () => import('../../../shared/properties/i18n/messages/ptBR'),
};

export type CatalogLoader = (locale: Locale) => Promise<Result<Catalog, AppError>>;

/**
 * A loader that imports each locale at most once, concurrent callers sharing one import. A
 * failure is not cached, so choosing the language again retries.
 */
export function createCatalogLoader(importers: CatalogImporters): CatalogLoader {
  const settled = new Map<Locale, Catalog>();
  const pending = new Map<Locale, Promise<Result<Catalog, AppError>>>();
  return (locale) => {
    const ready = settled.get(locale);
    if (ready !== undefined) {
      return Promise.resolve(ok(ready));
    }
    const running = pending.get(locale);
    if (running !== undefined) {
      return running;
    }
    const started = importCatalog(importers, locale).then((result) => {
      pending.delete(locale);
      if (result.ok) {
        settled.set(locale, result.value);
      }
      return result;
    });
    pending.set(locale, started);
    return started;
  };
}

export const loadCatalog: CatalogLoader = createCatalogLoader(SHIPPED_IMPORTERS);

async function importCatalog(importers: CatalogImporters, locale: Locale): Promise<Result<Catalog, AppError>> {
  let loaded: unknown;
  try {
    loaded = await importers[locale]();
  } catch (failure: unknown) {
    return err({ code: 'catalog-import-failed', message: `Could not load the ${locale} catalog: ${String(failure)}` });
  }
  // A module namespace holds the catalog under `messages`; the English importer hands it over directly.
  const candidate = typeof loaded === 'object' && loaded !== null && 'messages' in loaded ? loaded.messages : loaded;
  const parsed = parseCatalog(candidate);
  if (parsed.ok) {
    return parsed;
  }
  return err({ code: parsed.error.code, message: `The ${locale} catalog is invalid: ${parsed.error.message}` });
}

// Provides `t` to the tree without blocking the first render: English is on screen at once, and
// when the person's language is another one its catalog is imported in the background and the
// text swaps when it arrives. A failed import leaves English and says why in the console.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { createTranslator } from '../../../shared/core/i18n/catalog';
import { localeDirection, type Locale } from '../../../shared/core/i18n/locales';
import { messages as english } from '../../../shared/properties/i18n/messages/en';
import { resolveLocale } from '../../../shared/core/i18n/parseLocale';
import { ENGLISH, LocaleContext, warnOnce, type LocaleValue } from './localeContext';
import { loadCatalog, type CatalogLoader } from './loadCatalog';
import { readLocalePreference, subscribeLocalePreference, systemLanguageTags } from './localeStore';

interface Props {
  readonly children: ReactNode;
  /** Replaced by tests; the app uses the shipped lazy loader. */
  readonly loader?: CatalogLoader;
  /** Replaced by tests; the app asks the system. */
  readonly languageTags?: readonly string[];
}

export function LocaleProvider({ children, loader = loadCatalog, languageTags }: Props) {
  const preference = useSyncExternalStore(subscribeLocalePreference, readLocalePreference, readLocalePreference);
  const wanted: Locale = resolveLocale(preference, languageTags ?? systemLanguageTags());
  const [value, setValue] = useState<LocaleValue>(ENGLISH);
  useEffect(() => {
    if (wanted === 'en') {
      setValue(ENGLISH);
      return undefined;
    }
    let current = true;
    void loader(wanted).then((result) => {
      if (!current) {
        return;
      }
      if (result.ok) {
        const onIssue = warnOnce();
        setValue({ locale: wanted, translate: createTranslator({ locale: wanted, catalog: result.value, fallback: english, onIssue }) });
      } else {
        console.warn(`[i18n] ${result.error.message}`);
      }
    });
    return () => {
      current = false;
    };
  }, [wanted, loader]);
  // The document's language and direction follow what is on screen, not what was asked for, so
  // assistive technology never reads English text as Spanish while the catalog is on its way.
  useEffect(() => {
    assert(value.locale.length > 0, 'LocaleProvider: the active locale is set');
    document.documentElement.lang = value.locale;
    document.documentElement.dir = localeDirection(value.locale);
  }, [value.locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

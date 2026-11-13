// Provides `t` to the tree without blocking the first render: English is on screen at once, and
// when the person's language is another one its catalog is imported in the background and the
// text swaps when it arrives. A failed import leaves English and says why in the console.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { localeDirection, type Locale, type LocalePreference } from '../../../shared/core/i18n/locales';
import { resolveLocale } from '../../../shared/core/i18n/parseLocale';
import { buildLocaleValue, ENGLISH, LocaleContext, warnOnce, type LocaleValue } from './localeContext';
import { loadCatalog, type CatalogLoader } from './loadCatalog';
import { readLocalePreference, subscribeLocalePreference, systemLanguageTags } from './localeStore';

interface Props {
  readonly children: ReactNode;
  /** Replaced by tests; the app uses the shipped lazy loader. */
  readonly loader?: CatalogLoader;
  /** Replaced by tests; the app asks the system. */
  readonly languageTags?: readonly string[];
  /** Desktop passes the bridge that tells the main process (menu, dialogs); called on mount and at every change of the stored choice. */
  readonly onPreference?: (preference: LocalePreference) => void;
}

export function LocaleProvider({ children, loader = loadCatalog, languageTags, onPreference }: Props) {
  const preference = useSyncExternalStore(subscribeLocalePreference, readLocalePreference, readLocalePreference);
  const wanted: Locale = resolveLocale(preference, languageTags ?? systemLanguageTags());
  const [value, setValue] = useState<LocaleValue>(ENGLISH);
  useEffect(() => {
    onPreference?.(preference);
  }, [preference, onPreference]);
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
        setValue(buildLocaleValue(wanted, result.value, onIssue));
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

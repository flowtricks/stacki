// Design mode's words in the interface language: its own catalogs (one file per locale in this folder), picked
// by the app's current locale, English for anything missing. `{name}` placeholders are filled from `values`.
import type { Locale } from '../../../../shared/core/i18n/locales';
import { useLocale } from '../../../lib/i18n/useTranslate';
import { designModeEnglish, type DesignWordKey } from './en';
import { designModeCatalogs } from './catalogs';

export type DesignWords = (key: DesignWordKey, values?: Readonly<Record<string, string | number>>) => string;

/** One word of a catalog, its placeholders filled. */
export function designWord(locale: Locale, key: DesignWordKey, values?: Readonly<Record<string, string | number>>): string {
  const text = designModeCatalogs[locale]?.[key] ?? designModeEnglish[key];
  if (values === undefined) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

export function useDesignWords(): DesignWords {
  const { locale } = useLocale();
  return (key, values) => designWord(locale, key, values);
}

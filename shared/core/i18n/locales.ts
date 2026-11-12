// The interface languages Stacki ships, and the one source of truth for them (docs/i18n.md).
// A language is added here, in `messages/`, and in `loadCatalog.ts`; the catalog-parity test
// then holds the new catalog to English's keys and placeholders.

/** BCP 47 tags, English first: English is the source language every other catalog translates. */
export const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_DEFAULT: Locale = 'en';

/**
 * Each language written in itself, never translated: a person who cannot read the current
 * language must still find their own in the list.
 */
export const LOCALE_NATIVE_NAMES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
} as const satisfies Record<Locale, string>;

/** What a person chooses: a language, or "follow the system". */
export const LOCALE_PREFERENCES = ['system', ...LOCALES] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const LOCALE_PREFERENCE_DEFAULT: LocalePreference = 'system';

/** Text direction of a locale, for the `dir` attribute. Every shipped language is left to right; right to left is a later phase. */
export type TextDirection = 'ltr' | 'rtl';

export function localeDirection(locale: Locale): TextDirection {
  switch (locale) {
    case 'en':
    case 'es':
    case 'fr':
    case 'de':
    case 'pt-BR':
      return 'ltr';
    default: {
      const exhaustive: never = locale;
      return exhaustive;
    }
  }
}

// i18n-ignore-file: a language is always named in its own language (Deutsch, 日本語, العربية), so these names are the same whatever language the interface is in.
// The interface languages Stacki ships, and the one source of truth for them (docs/i18n.md).
// A language is added here (its tag in `LOCALES` and its row in `LOCALE_INFO`), as a catalog directory in `messages/`, and as one importer in
// each loader the compiler then asks for (`loadCatalog.ts`, `mainLocale.ts`, Studio's `requestTranslate.ts`); the catalog-parity test holds
// the new catalog to English's keys and placeholders, and the switcher, the parsers and the tests read the list from here.

/**
 * BCP 47 tags, English first: English is the source language every other catalog translates. The order is the switcher's order, and
 * also decides a primary-language match: "zh" alone gets the first Chinese locale, "zh-CN".
 */
export const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'nl', 'pl', 'tr', 'ru', 'id', 'hi', 'ar', 'he', 'ja', 'ko', 'zh-CN', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_DEFAULT: Locale = 'en';

/** Text direction of a locale, for the `dir` attribute. */
export type TextDirection = 'ltr' | 'rtl';

export interface LocaleInfo {
  /**
   * The language written in itself, never translated: a person who cannot read the current language must still find their own in the
   * list.
   */
  readonly nativeName: string;
  /** The catalog directory under `shared/properties/i18n/messages/`: the tag without its hyphen, because a directory name is an identifier. */
  readonly directory: string;
  /** Right to left for Arabic and Hebrew; the document root's `dir` follows it, and the interface lays out with logical properties. */
  readonly direction: TextDirection;
}

/** One row per shipped locale; the compiler rejects a locale without a row. */
export const LOCALE_INFO = {
  en: { nativeName: 'English', directory: 'en', direction: 'ltr' },
  es: { nativeName: 'Español', directory: 'es', direction: 'ltr' },
  fr: { nativeName: 'Français', directory: 'fr', direction: 'ltr' },
  de: { nativeName: 'Deutsch', directory: 'de', direction: 'ltr' },
  'pt-BR': { nativeName: 'Português (Brasil)', directory: 'ptBR', direction: 'ltr' },
  it: { nativeName: 'Italiano', directory: 'it', direction: 'ltr' },
  nl: { nativeName: 'Nederlands', directory: 'nl', direction: 'ltr' },
  pl: { nativeName: 'Polski', directory: 'pl', direction: 'ltr' },
  tr: { nativeName: 'Türkçe', directory: 'tr', direction: 'ltr' },
  ru: { nativeName: 'Русский', directory: 'ru', direction: 'ltr' },
  id: { nativeName: 'Bahasa Indonesia', directory: 'id', direction: 'ltr' },
  hi: { nativeName: 'हिन्दी', directory: 'hi', direction: 'ltr' },
  ar: { nativeName: 'العربية', directory: 'ar', direction: 'rtl' },
  he: { nativeName: 'עברית', directory: 'he', direction: 'rtl' },
  ja: { nativeName: '日本語', directory: 'ja', direction: 'ltr' },
  ko: { nativeName: '한국어', directory: 'ko', direction: 'ltr' },
  'zh-CN': { nativeName: '中文（简体）', directory: 'zhCN', direction: 'ltr' },
  'zh-TW': { nativeName: '中文（繁體）', directory: 'zhTW', direction: 'ltr' },
} as const satisfies Record<Locale, LocaleInfo>;

/**
 * Language tags that name a shipped locale without sharing its spelling, lowercase, matched as a whole tag or as the start of one
 * (`zh-hant-tw` starts with `zh-hant`). Chinese is chosen by script, not by the primary language alone: Hong Kong and Macau write
 * Traditional characters. `iw` and `in` are the old codes for Hebrew and Indonesian that some systems still report.
 */
export const LOCALE_TAG_ALIASES = {
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  iw: 'he',
  in: 'id',
} as const satisfies Record<string, Locale>;

/** What a person chooses: a language, or "follow the system". */
export const LOCALE_PREFERENCES = ['system', ...LOCALES] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const LOCALE_PREFERENCE_DEFAULT: LocalePreference = 'system';

export function localeDirection(locale: Locale): TextDirection {
  return LOCALE_INFO[locale].direction;
}

export function localeNativeName(locale: Locale): string {
  return LOCALE_INFO[locale].nativeName;
}

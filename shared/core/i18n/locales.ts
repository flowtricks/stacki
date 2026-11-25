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

/** The countries whose flags are vendored in `src/ui/flags/flagPaths.ts`; that table is keyed by this union, so a flag without artwork cannot compile. */
export type FlagCountry = 'br' | 'cn' | 'de' | 'es' | 'fr' | 'id' | 'il' | 'in' | 'it' | 'jp' | 'kr' | 'nl' | 'pl' | 'ru' | 'sa' | 'tr' | 'tw' | 'us';

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
  /**
   * The short mark: two letters of the language code, and for the two Chinese locales the script's own character (简, 繁), because their
   * codes share "ZH". It is the fallback `LocaleMark` draws only when `flag` has no artwork.
   */
  readonly mark: string;
  /**
   * The country flag drawn beside the language in the switcher (`LocaleMark`). A language is not a country, so each is a judgement call:
   * English is the United States (the largest English-speaking audience; GB is the alternative), Arabic is Saudi Arabia (the most
   * widely recognised neutral choice; EG or AE would also do), Portuguese is Brazil (the catalog is pt-BR), Chinese is China for
   * simplified and Taiwan for traditional, Hindi is India, and the rest are their own country.
   */
  readonly flag: FlagCountry;
}

/** One row per shipped locale; the compiler rejects a locale without a row. */
export const LOCALE_INFO = {
  en: { nativeName: 'English', directory: 'en', direction: 'ltr', mark: 'EN', flag: 'us' },
  es: { nativeName: 'Español', directory: 'es', direction: 'ltr', mark: 'ES', flag: 'es' },
  fr: { nativeName: 'Français', directory: 'fr', direction: 'ltr', mark: 'FR', flag: 'fr' },
  de: { nativeName: 'Deutsch', directory: 'de', direction: 'ltr', mark: 'DE', flag: 'de' },
  'pt-BR': { nativeName: 'Português (Brasil)', directory: 'ptBR', direction: 'ltr', mark: 'PT', flag: 'br' },
  it: { nativeName: 'Italiano', directory: 'it', direction: 'ltr', mark: 'IT', flag: 'it' },
  nl: { nativeName: 'Nederlands', directory: 'nl', direction: 'ltr', mark: 'NL', flag: 'nl' },
  pl: { nativeName: 'Polski', directory: 'pl', direction: 'ltr', mark: 'PL', flag: 'pl' },
  tr: { nativeName: 'Türkçe', directory: 'tr', direction: 'ltr', mark: 'TR', flag: 'tr' },
  ru: { nativeName: 'Русский', directory: 'ru', direction: 'ltr', mark: 'RU', flag: 'ru' },
  id: { nativeName: 'Bahasa Indonesia', directory: 'id', direction: 'ltr', mark: 'ID', flag: 'id' },
  hi: { nativeName: 'हिन्दी', directory: 'hi', direction: 'ltr', mark: 'HI', flag: 'in' },
  ar: { nativeName: 'العربية', directory: 'ar', direction: 'rtl', mark: 'AR', flag: 'sa' },
  he: { nativeName: 'עברית', directory: 'he', direction: 'rtl', mark: 'HE', flag: 'il' },
  ja: { nativeName: '日本語', directory: 'ja', direction: 'ltr', mark: 'JA', flag: 'jp' },
  ko: { nativeName: '한국어', directory: 'ko', direction: 'ltr', mark: 'KO', flag: 'kr' },
  'zh-CN': { nativeName: '中文（简体）', directory: 'zhCN', direction: 'ltr', mark: '简', flag: 'cn' },
  'zh-TW': { nativeName: '中文（繁體）', directory: 'zhTW', direction: 'ltr', mark: '繁', flag: 'tw' },
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

// i18n-ignore-file: these are developer diagnostics for a malformed locale value (a boundary parse error), not interface text.
// Locale boundaries (docs/i18n.md): what storage hands back, and what the browser or the
// operating system reports, become a `Locale` here and nowhere else. Nothing is cast.
import { assert } from '../assert';
import { err, ok, type Result } from '../result';
import { LOCALE_DEFAULT, LOCALE_PREFERENCES, LOCALES, type Locale, type LocalePreference } from './locales';

/** Characters in a language tag. BCP 47 allows long private-use tags; no shipped language needs more than a few. */
const LANGUAGE_TAG_CHARS_MAX = 35;
/** Tags considered from `navigator.languages`; the first match wins, so the rest rarely matter. */
const LANGUAGE_TAGS_MAX = 32;

/** A shipped locale, exactly as spelled in `LOCALES`. Case matters: storage written by this app is exact, anything else is refused. */
export function parseLocale(input: unknown): Result<Locale> {
  if (typeof input !== 'string') {
    return err({ code: 'locale-type', message: 'A locale is a string' });
  }
  if (input.length > LANGUAGE_TAG_CHARS_MAX) {
    return err({ code: 'locale-length', message: 'Locale tag is too long' });
  }
  const found = LOCALES.find((locale) => locale === input);
  if (found === undefined) {
    return err({ code: 'locale-unknown', message: `Unsupported locale "${input}"` });
  }
  return ok(found);
}

/** A stored choice: a shipped locale or "system". */
export function parseLocalePreference(input: unknown): Result<LocalePreference> {
  const found = LOCALE_PREFERENCES.find((preference) => preference === input);
  if (found === undefined) {
    return err({ code: 'preference-unknown', message: 'Unsupported language preference' });
  }
  return ok(found);
}

/**
 * The shipped locale that best matches one language tag: an exact match, else the first shipped
 * locale with the same primary language ("pt-PT" and "pt" get "pt-BR"; "es-MX" gets "es").
 * Undefined when no shipped language fits.
 */
export function matchLocale(languageTag: string): Locale | undefined {
  assert(typeof languageTag === 'string', 'matchLocale: the tag is a string');
  if (languageTag.length === 0 || languageTag.length > LANGUAGE_TAG_CHARS_MAX) {
    return undefined;
  }
  const lower = languageTag.toLowerCase().replaceAll('_', '-');
  const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact !== undefined) {
    return exact;
  }
  const primary = lower.split('-')[0];
  return LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === primary);
}

/** The first of the system's preferred languages that Stacki ships, or English. */
export function systemLocale(languageTags: readonly string[]): Locale {
  assert(languageTags.length <= LANGUAGE_TAGS_MAX, 'systemLocale: at most LANGUAGE_TAGS_MAX tags');
  for (const tag of languageTags) {
    const matched = matchLocale(tag);
    if (matched !== undefined) {
      return matched;
    }
  }
  return LOCALE_DEFAULT;
}

/** The locale a preference means on this system. */
export function resolveLocale(preference: LocalePreference, languageTags: readonly string[]): Locale {
  if (preference === 'system') {
    return systemLocale(languageTags.slice(0, LANGUAGE_TAGS_MAX));
  }
  const found = parseLocale(preference);
  assert(found.ok, 'resolveLocale: a non-system preference is a shipped locale');
  return found.value;
}

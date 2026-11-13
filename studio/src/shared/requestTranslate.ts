// A translator for pages the Worker renders itself (the sign-in page), before the editor and its `LocaleProvider` exist. The person's
// languages come from the request's Accept-Language header; the same matching as the editor applies (`resolveLocale`), and anything
// unknown or absent is English. Only the `studio` catalogs are imported, so the Worker carries a few dozen short messages per language.
import { createTranslator, type Catalog, type Translate } from '../../vendor/stacki/shared/core/i18n/catalog';
import type { Locale } from '../../vendor/stacki/shared/core/i18n/locales';
import { resolveLocale } from '../../vendor/stacki/shared/core/i18n/parseLocale';
import { messages as de } from '../../vendor/stacki/shared/properties/i18n/messages/de/studio';
import { messages as en, type MessageKey } from '../../vendor/stacki/shared/properties/i18n/messages/en/studio';
import { messages as es } from '../../vendor/stacki/shared/properties/i18n/messages/es/studio';
import { messages as fr } from '../../vendor/stacki/shared/properties/i18n/messages/fr/studio';
import { messages as ptBR } from '../../vendor/stacki/shared/properties/i18n/messages/ptBR/studio';

export type RequestTranslator = { readonly locale: Locale; readonly translate: Translate<MessageKey> };

const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, es, fr, de, 'pt-BR': ptBR };
const LANGUAGES_MAX = 16;
const HEADER_CHARS_MAX = 500;

/** The languages an Accept-Language header lists, best first: `"fr-CA, fr;q=0.8, en;q=0.5"`. Malformed parts are dropped. */
export function acceptedLanguages(header: string | null | undefined): readonly string[] {
  if (typeof header !== 'string') {
    return [];
  }
  const ranked: { readonly tag: string; readonly weight: number; readonly order: number }[] = [];
  const parts = header.slice(0, HEADER_CHARS_MAX).split(',').slice(0, LANGUAGES_MAX);
  for (const [order, part] of parts.entries()) {
    const [rawTag = '', ...parameters] = part.split(';');
    const tag = rawTag.trim();
    const weightText = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith('q='));
    const weight = weightText === undefined ? 1 : Number(weightText.slice(2));
    if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag) && Number.isFinite(weight) && weight > 0) {
      ranked.push({ tag, weight, order });
    }
  }
  ranked.sort((first, second) => second.weight - first.weight || first.order - second.order);
  return ranked.map((entry) => entry.tag);
}

/** English when `header` is absent, which is also what tests and direct callers get. */
export function translatorForLanguages(header: string | null | undefined): RequestTranslator {
  const locale = resolveLocale('system', acceptedLanguages(header));
  const translate = createTranslator<MessageKey>({ locale, catalog: CATALOGS[locale], fallback: en, onIssue: () => undefined });
  return { locale, translate };
}

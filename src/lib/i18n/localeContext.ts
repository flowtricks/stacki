// What a component reads: the active locale and `t`. Without a provider (a unit test, a story) the
// context is English, so a component never needs one to render.
import { createContext } from 'react';
import { createTranslator, type CatalogIssue, type Translate } from '../../../shared/core/i18n/catalog';
import { LOCALE_DEFAULT, type Locale } from '../../../shared/core/i18n/locales';
import { messages as english } from '../../../shared/properties/i18n/messages/en';
import type { MessageKey } from '../../../shared/properties/i18n/messages/en';

export type { MessageKey };
export type Translator = Translate<MessageKey>;

export interface LocaleValue {
  readonly locale: Locale;
  readonly translate: Translator;
}

/** Heard for each key that fell back to English. Development warns once per message; tests replace it with a throw. */
export function warnOnce(): (issue: CatalogIssue) => void {
  const seen = new Set<string>();
  return (issue) => {
    const id = `${issue.locale}:${issue.key}:${issue.kind}`;
    if (!seen.has(id) && seen.size < 1_000) {
      seen.add(id);
      console.warn(`[i18n] ${issue.kind} ${issue.locale} ${issue.key}${issue.kind === 'bad-message' ? `: ${issue.reason}` : ''}`);
    }
  };
}

export const ENGLISH: LocaleValue = {
  locale: LOCALE_DEFAULT,
  translate: createTranslator({ locale: LOCALE_DEFAULT, catalog: english, fallback: english, onIssue: warnOnce() }),
};

export const LocaleContext = createContext<LocaleValue>(ENGLISH);

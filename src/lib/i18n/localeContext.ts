// What a component reads: the active locale and the functions that turn keys into text. Without a provider (a unit test, a
// story) the context is English, so a component never needs one to render.
import { createContext } from 'react';
import { createTranslator, formatMessage, type Catalog, type CatalogIssue, type Translate } from '../../../shared/core/i18n/catalog';
import { formattersFor, type Formatters } from '../../../shared/core/i18n/format';
import { LOCALE_DEFAULT, type Locale } from '../../../shared/core/i18n/locales';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { createRichTranslator } from '../../../shared/core/i18n/richText';
import { messages as english } from '../../../shared/properties/i18n/messages/en/index';
import type { MessageKey } from '../../../shared/properties/i18n/messages/en/index';
import type { TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import { createReactRichTranslator, type RichTranslator } from './translateRich';

export type { MessageKey };
export type Translator = Translate<MessageKey>;

/** Translates a reference produced by pure code in this repository: its key is checked at compile time, so there is nothing to fall back to. */
export type RefTranslator = (ref: TypedMessageRef) => string;

/**
 * Translates a result that carries its English `message` and, optionally, a reference to the same sentence (a `Described`): a
 * reference from a producer that may be newer or older than this window, or a result with no reference at all, shows the message.
 */
export type DescribedTranslator = (described: { readonly message: string; readonly messageRef?: MessageRef | undefined }) => string;

export interface LocaleValue {
  readonly locale: Locale;
  readonly translate: Translator;
  /** For sentences with inline code, links or emphasis: `translateRich('x.y', { file: <code>…</code>, link: (text) => <a>{text}</a> })`. */
  readonly translateRich: RichTranslator;
  readonly translateRef: RefTranslator;
  readonly translateDescribed: DescribedTranslator;
  /** Numbers, dates, relative times, lists and sizes in this locale. */
  readonly format: Formatters;
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

/** True when `key` is a message the English catalog has: the guard that lets a key from outside the code reach `translate`. */
export function isKnownMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(english, key);
}

/** Everything a component can ask of a locale, built from one catalog. English is its own fallback. */
export function buildLocaleValue(locale: Locale, catalog: Catalog, onIssue: (issue: CatalogIssue) => void): LocaleValue {
  const options = { locale, catalog, fallback: english, onIssue };
  const translate = createTranslator(options);
  const translateRef: RefTranslator = (ref) => translate(ref.key, ref.params);
  const translateDescribed: DescribedTranslator = (value) => {
    const reference = value.messageRef;
    if (reference === undefined || !isKnownMessageKey(reference.key)) {
      return value.message;
    }
    // A reference crossed a process boundary: a parameter its producer forgot is that producer's bug, but it must not crash the window.
    const probe = formatMessage('en', english[reference.key], reference.params ?? {});
    return probe.ok ? translate(reference.key, reference.params) : value.message;
  };
  return {
    locale,
    translate,
    translateRich: createReactRichTranslator(createRichTranslator(options)),
    translateRef,
    translateDescribed,
    format: formattersFor(locale),
  };
}

export const ENGLISH: LocaleValue = buildLocaleValue(LOCALE_DEFAULT, english, warnOnce());

export const LocaleContext = createContext<LocaleValue>(ENGLISH);

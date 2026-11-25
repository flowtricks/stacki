import { useContext } from 'react';
import type { Formatters } from '../../../shared/core/i18n/format';
import { LocaleContext, type DescribedTranslator, type LocaleValue, type RefTranslator, type Translator } from './localeContext';
import type { RichTranslator } from './translateRich';

/** `translate('settings.title')`: the text for a key in the active language, English until its catalog arrives. */
export function useTranslate(): Translator {
  return useContext(LocaleContext).translate;
}

/** The active locale, for `Intl.*` formatting and `lang`. */
export function useLocale(): LocaleValue {
  return useContext(LocaleContext);
}

/** For sentences with inline code, links or emphasis (docs/i18n-playbook.md, "Rich text"). */
export function useTranslateRich(): RichTranslator {
  return useContext(LocaleContext).translateRich;
}

/** For a `TypedMessageRef` that pure code returned (a validation problem, a refusal): `translateRef(problem)`. */
export function useTranslateRef(): RefTranslator {
  return useContext(LocaleContext).translateRef;
}

/** For a result with an English `message` and an optional `messageRef` (IPC replies, `Described`): `translateDescribed(result)`. */
export function useTranslateDescribed(): DescribedTranslator {
  return useContext(LocaleContext).translateDescribed;
}

/** `formatNumber`, `formatDate`, `formatRelativeTime`, `formatList`, `formatBytes` for the active locale. */
export function useFormat(): Formatters {
  return useContext(LocaleContext).format;
}

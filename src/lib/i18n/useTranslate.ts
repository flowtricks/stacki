import { useContext } from 'react';
import { LocaleContext, type LocaleValue, type Translator } from './localeContext';

/** `translate('settings.title')`: the text for a key in the active language, English until its catalog arrives. */
export function useTranslate(): Translator {
  return useContext(LocaleContext).translate;
}

/** The active locale, for `Intl.*` formatting and `lang`. */
export function useLocale(): LocaleValue {
  return useContext(LocaleContext);
}

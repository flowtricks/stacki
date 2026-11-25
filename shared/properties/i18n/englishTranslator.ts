// `translate` fixed to English, for code that has no language to follow: logs, tests, fallbacks, and the English form of a function that
// also has a translated one (docs/i18n-playbook.md). Components never use it; they take `translate` from `useTranslate()`.
import { createTranslator } from '../../core/i18n/catalog';
import { messages as english } from './messages/en/index';
import type { Translator } from './messageRef';

export const ENGLISH_TRANSLATE: Translator = createTranslator({
  locale: 'en',
  catalog: english,
  fallback: english,
  // English is the source: a message that fails to format is a programmer error, and `createTranslator` already asserts on it.
  onIssue: () => undefined,
});

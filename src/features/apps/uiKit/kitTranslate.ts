// The UI kit's translator. The kit runs inside an app's own frame, which has no locale provider, so the components it shares with the
// editor (Dropdown, ResetLabel) read their text from this module instead of src/lib/i18n/useTranslate: scripts/build/appUiKitSource.mts
// redirects that one import here when it compiles the kit. Why: the real hook reaches the English catalog of every namespace (hundreds of
// kilobytes) and the locale provider, none of which an app iframe can use. Only the `ui` namespace is imported, so the kit's default text
// stays the editor's own English words and cannot drift from them; apps translate a kit element by passing it a `label` or `placeholder`.
import { messages } from '../../../../shared/properties/i18n/messages/en/ui';
import type { Translator } from '../../../lib/i18n/localeContext';

const TABLE: Readonly<Record<string, string | { readonly other: string }>> = messages;

/** English text for a `ui.*` key. A key from another namespace is a programmer error: the kit's components must only use `ui` words. */
const translate: Translator = (key, params) => {
  const entry = TABLE[key];
  if (entry === undefined) {
    throw new Error(`Assertion failed: the UI kit has no text for ${key}; kit components use only ui.* keys`);
  }
  const template = typeof entry === 'string' ? entry : entry.other;
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
};

/** The same shape as `useTranslate`: the kit has one language, so the hook returns one function. */
export function useTranslate(): Translator {
  return translate;
}

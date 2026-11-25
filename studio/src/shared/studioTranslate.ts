// Text for Studio code that has no component in scope. The collaboration document is a class that outlives renders, and a few of its
// sentences (a refused edit, a lost session) are shown from event handlers, so they cannot call `useTranslate()`. The mounted app hands
// its current translator to this module (`useStudioTranslatorBridge`); every later call speaks the language on screen. Before the app
// mounts, and in tests, it is English. The one module-level variable is written in one place and read in one function.
import { useEffect } from 'react';
import { parseMessageRef, type MessageRef } from '../../vendor/stacki/shared/core/i18n/messageReference';
import { ENGLISH_TRANSLATE } from '../../vendor/stacki/shared/properties/i18n/englishTranslator';
import type { Translator } from '../../vendor/stacki/shared/properties/i18n/messageRef';
import { isKnownMessageKey } from '../../vendor/stacki/src/lib/i18n/localeContext';
import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';

let current: Translator = ENGLISH_TRANSLATE;

/** Translates now, in the language the person has chosen. */
export const studioTranslate: Translator = (key, params) => current(key, params);

/**
 * Shows a sentence that came from the server together with its English text: the translation when this window knows the key and the
 * parameters fit, otherwise the English `message` (an older or newer server). Never throws on a malformed reference.
 */
export function studioTranslateRef(message: string, ref: MessageRef | undefined): string {
  if (ref === undefined || !isKnownMessageKey(ref.key)) {
    return message;
  }
  try {
    return current(ref.key, ref.params);
  } catch {
    return message;
  }
}

/** The text of a server message `{ message, messageRef? }` (a collaboration room's error): translated when it carries a reference this window knows. */
export function studioWireText(wire: Readonly<Record<string, unknown>>): string {
  const message = typeof wire['message'] === 'string' ? wire['message'] : '';
  const parsed = parseMessageRef(wire['messageRef']);
  return studioTranslateRef(message, parsed.ok ? parsed.value : undefined);
}

/** Mount once inside the `LocaleProvider`: keeps `studioTranslate` in step with the chosen language. */
export function useStudioTranslatorBridge(): void {
  const translate = useTranslate();
  useEffect(() => {
    current = translate;
  }, [translate]);
}

// The language for Studio's chat code that cannot call a hook (state, actions, image preparation). The panel hands over its
// `translate` each time the language changes; until then, and in tests, these are English. A sentence written here is fixed in
// the language current when it was made (an error shown once, a chat's default name), which is how a name the person types behaves too.
import { ENGLISH_TRANSLATE } from '../../../vendor/stacki/shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

let current: Translator = ENGLISH_TRANSLATE;

export function setStudioTranslate(translate: Translator): void {
  current = translate;
}

export function studioTranslate(): Translator {
  return current;
}

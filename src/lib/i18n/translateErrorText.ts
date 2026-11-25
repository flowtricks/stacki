// Shows an error that came from the main process in the language on screen. Their sentences arrive as English text plus, for the ones we
// wrote ourselves, a reference to the catalog message (docs/i18n-playbook.md sections 7 and 9). Text without a reference (git's own output,
// a network message) is shown as received. A reference this window does not know, or whose parameters do not fit, falls back to the
// English text, so a newer producer can never crash the screen. No React here: pure action code (`gitActions`) takes a `translate`.
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { splitReferencedMessage } from '../../../shared/core/i18n/referencedMessage';
import { messages as english } from '../../../shared/properties/i18n/messages/en/index';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import type { Failure } from '../cleanError';

function isKnownKey(key: string): key is MessageKey {
  return Object.hasOwn(english, key);
}

/** `message` in the active language when `reference` names a message this window has and its parameters fit; otherwise `message`. */
export function translateReference(message: string, reference: MessageRef | undefined, translate: Translator): string {
  if (reference === undefined || !isKnownKey(reference.key)) {
    return message;
  }
  try {
    return translate(reference.key, reference.params);
  } catch {
    return message;
  }
}

/** Error text as `cleanErrorKeepingReference` returns it (English sentence, optionally followed by an appended reference). */
export function translateErrorText(text: string, translate: Translator): string {
  const { message, messageRef } = splitReferencedMessage(text);
  return translateReference(message, messageRef, translate);
}

/** A failure result (`failureOf`, or a reply with `error` and `errorRef`) in the active language. */
export function translateFailure(failure: Pick<Failure, 'error' | 'errorRef'>, translate: Translator): string {
  return translateReference(failure.error, failure.errorRef, translate);
}

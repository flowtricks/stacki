// An error whose English text travels with a reference to the same sentence, so the editor that receives it over the wire can show it in
// the person's language (docs/i18n-playbook.md section 7). The server has no language of its own; `message` stays for older readers and logs.
import { messageRef, englishText, type TypedMessageRef, type MessageKey } from '../../vendor/stacki/shared/properties/i18n/messageRef';
import { problemOf } from '../../vendor/stacki/shared/properties/describedError';
import { referenceOfError } from '../../vendor/stacki/shared/core/i18n/referencedMessage';
import type { MessageRef } from '../../vendor/stacki/shared/core/i18n/messageReference';
import type { MessageParams } from '../../vendor/stacki/shared/core/i18n/catalog';

export class ReferencedError extends Error {
  readonly messageRef: TypedMessageRef;

  constructor(key: MessageKey, params?: MessageParams) {
    const reference = messageRef(key, params);
    super(englishText(reference));
    this.messageRef = reference;
  }
}

/**
 * The wire fields for an error: its English message and, when it carries one, its reference. A reference comes from this twin of
 * `ReferencedError`, from a `DescribedError` (what `published()` throws), or from the `messageRef` property of a `ReferencedError` that
 * vendored Desktop code threw (the shared class is a different class from this twin, so it is read by its property).
 */
export function errorWire(error: unknown, fallbackKey: MessageKey): { readonly message: string; readonly messageRef?: MessageRef } {
  if (error instanceof ReferencedError) {
    return { message: error.message, messageRef: error.messageRef };
  }
  if (error instanceof Error) {
    const reference = problemOf(error).messageRef ?? referenceOfError(error);
    return reference === undefined ? { message: error.message } : { message: error.message, messageRef: reference };
  }
  const reference = messageRef(fallbackKey);
  return { message: englishText(reference), messageRef: reference };
}

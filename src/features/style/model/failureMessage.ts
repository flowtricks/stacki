// A failed write as the style models report it: the English `error` they always returned, plus the message reference the panel
// translates (docs/i18n-playbook.md, section 6). Pure model code has no `translate`, so it hands the reference to the caller.

import type { MessageParams } from '../../../../shared/core/i18n/catalog';
import { englishText, messageRef, type MessageKey, type TypedMessageRef } from '../../../../shared/properties/i18n/messageRef';

// `errorRef` is absent when the text came from a parser or the host, which is shown as received.
export type Failure = { readonly ok: false; readonly error: string; readonly errorRef?: TypedMessageRef | undefined };

/** `{ ok: false, error, errorRef }` for a catalog message; `error` is its English text. */
export function failureOf(key: MessageKey, params?: MessageParams): Failure & { readonly errorRef: TypedMessageRef } {
  const errorRef = messageRef(key, params);
  return { ok: false, error: englishText(errorRef), errorRef };
}

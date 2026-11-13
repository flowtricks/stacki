// The error the media-host form validators throw when a person typed something unusable (a bad URL, a short bucket name).
// It is an expected failure of user input, shown in the connect form, so it carries a message reference beside the English
// sentence it always had: the renderer translates the reference, and every older reader still gets `message`.
// Programmer errors elsewhere in the parsers stay plain `Error` (AGENTS.md section 9).
import { englishText, messageRef, type MessageKey, type TypedMessageRef } from './i18n/messageRef';
import type { MessageParams } from '../core/i18n/catalog';

export class MediaInputError extends Error {
  readonly messageRef: TypedMessageRef;

  constructor(key: MessageKey, params?: MessageParams) {
    const reference = messageRef(key, params);
    super(englishText(reference));
    this.name = 'MediaInputError';
    this.messageRef = reference;
  }
}

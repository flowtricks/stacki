// An error whose English text travels with a reference to the same sentence, so the renderer that receives the failure over IPC can show it
// in the person's language (docs/i18n-playbook.md section 7). The main process and the vendored server code have no language of their own;
// `message` stays for older readers and logs. Studio keeps its own twin in studio/src/shared/referencedError.ts.
import type { MessageParams } from '../../core/i18n/catalog';
import { englishText, messageRef, type MessageKey, type TypedMessageRef } from './messageRef';

export class ReferencedError extends Error {
  readonly messageRef: TypedMessageRef;

  constructor(key: MessageKey, params?: MessageParams) {
    const reference = messageRef(key, params);
    super(englishText(reference));
    this.messageRef = reference;
  }
}

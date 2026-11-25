// The sentences this folder sends to the renderer, as stable references beside their English text (docs/i18n-playbook.md,
// "Shared-layer strings"). The renderer translates by `messageRef`; `message` / `text` stay for logs, old readers and tests.
// Log lines and errors thrown for programmers are not here: they stay English.
import type { MessageParams } from '../../../shared/core/i18n/catalog';
import { described, type MessageKey } from '../../../shared/properties/i18n/messageRef';

export { described };

/** A chat event's `text` and `textRef` for a notice Stacki itself words (not the agent's own text). */
export function noticeText(key: MessageKey, params?: MessageParams): { readonly text: string; readonly textRef: ReturnType<typeof described>['messageRef'] } {
  const { message, messageRef } = described(key, params);
  return { text: message, textRef: messageRef };
}

// The failure an Apps route answers with: the English `message` older readers show, and the `messageRef` the editor translates
// (docs/i18n-playbook.md, "Shared-layer strings"). The server has no language of its own; the person's browser does.
import { described, type MessageKey } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

/** `{ ok: false, message, messageRef }` for a catalog message. */
export function appsRefusal(key: MessageKey, params?: Readonly<Record<string, string | number>>) {
  const text = params === undefined ? described(key) : described(key, params);
  return { ok: false as const, message: text.message, messageRef: text.messageRef };
}

// The editor document's save status doubles as an identifier (`status === 'Saved'` gates sign-out and publishing), so the values stay the
// English words the document sets. This table maps each to the sentence a person reads; an unknown status shows as itself.
import type { MessageKey } from '../../../vendor/stacki/shared/properties/i18n/messages/en/studio';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  Connecting: 'studio.status.connecting',
  Saving: 'studio.status.saving',
  Saved: 'studio.status.saved',
  'Offline · edits pending': 'studio.status.offline',
  'Sign-in required': 'studio.status.signInRequired',
  'Reconnecting…': 'studio.status.reconnecting',
  'Needs attention': 'studio.status.needsAttention',
};

export function saveStatusLabel(status: string, translate: Translator): string {
  const key = Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status] : undefined;
  return key === undefined ? status : translate(key);
}

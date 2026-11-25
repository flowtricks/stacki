// The editor document's save status doubles as an identifier (`status === 'Saved'` gates sign-out and publishing), so the values stay the
// English words the document sets. This table maps each to the sentence a person reads; an unknown status shows as itself.
import type { MessageKey } from '../../../vendor/stacki/shared/properties/i18n/messages/en/studio';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { attentionLabel, type AttentionCause } from './attention';

export const NEEDS_ATTENTION = 'Needs attention';

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  Connecting: 'studio.status.connecting',
  Saving: 'studio.status.saving',
  Saved: 'studio.status.saved',
  'Offline · edits pending': 'studio.status.offline',
  'Sign-in required': 'studio.status.signInRequired',
  'Reconnecting…': 'studio.status.reconnecting',
  [NEEDS_ATTENTION]: 'studio.status.needsAttention',
};

export function saveStatusLabel(status: string, translate: Translator, attention: readonly AttentionCause[] = []): string {
  // 'Needs attention' names its one cause when there is exactly one ("Draft not saved"); several causes keep the general words.
  if (status === NEEDS_ATTENTION) {
    return attentionLabel(attention, translate);
  }
  const key = Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status] : undefined;
  return key === undefined ? status : translate(key);
}

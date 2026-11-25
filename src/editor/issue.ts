// A sentence that pure editor code returns instead of showing: the English text beside the message reference the renderer translates
// (docs/i18n-playbook.md, section 6). Code that shows its problem on the spot takes `translate` instead; code whose answer is stored or
// handed on (a plan, a section reading) returns an `Issue`, and `spoken` turns one into the active language where it is finally drawn.
import { described, type Described, type MessageKey, type TypedMessageRef } from '../../shared/properties/i18n/messageRef';
import type { MessageParams } from '../../shared/core/i18n/catalog';
import type { Translator } from '../../shared/properties/i18n/messageRef';

export type Issue = Described & { readonly messageRef: TypedMessageRef };

/** An issue for `key`: `issue('editor.loopSections.tooLong')`. */
export function issue(key: MessageKey, params?: MessageParams): Issue {
  return described(key, params);
}

/** The issue in the language `translate` speaks. */
export function spoken(value: Issue, translate: Translator): string {
  return value.messageRef.params === undefined ? translate(value.messageRef.key) : translate(value.messageRef.key, value.messageRef.params);
}

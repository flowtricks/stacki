// The typed way to make and read a message reference in `shared/` and other pure code (docs/i18n-playbook.md, "Shared and
// main-process text"). The key must exist in the English catalog, so a typo or a removed message is a compile error at the
// producer, not a silent English fallback in the renderer.
import { assert } from '../../core/assert';
import { formatMessage, type MessageParams, type Translate } from '../../core/i18n/catalog';
import type { MessageRef } from '../../core/i18n/messageReference';
import { messages as english } from './messages/en/index';
import type { MessageKey } from './messages/en/index';

export type { MessageKey, MessageRef };
export type TypedMessageRef = MessageRef<MessageKey>;

/** `translate` for the catalog's keys: what pure code that must produce a sentence on the spot takes as its last parameter. */
export type Translator = Translate<MessageKey>;

/**
 * A result carrying both forms of one sentence: the English text (logs, tests, and every consumer that predates
 * references) and the reference the renderer translates. `messageRef` is optional on the wire so older producers still parse.
 */
export interface Described {
  readonly message: string;
  readonly messageRef?: MessageRef | undefined;
}

/** `messageRef('audits.finding.rawValue', { name })`: stable id and parameters, translated by the renderer. */
export function messageRef(key: MessageKey, params?: MessageParams): TypedMessageRef {
  return params === undefined ? { key } : { key, params };
}

/** The English sentence for a reference: the fallback text, the log line, the expected value in a test. Asserts a missing parameter. */
export function englishText(ref: TypedMessageRef): string {
  const text = formatMessage('en', english[ref.key], ref.params ?? {});
  assert(text.ok, `englishText: "${ref.key}" formats with the parameters passed`);
  return text.value;
}

/** A reference together with its English text, for result shapes that already have a `message` field. */
export function described(key: MessageKey, params?: MessageParams): Described & { readonly messageRef: TypedMessageRef } {
  const reference = messageRef(key, params);
  return { message: englishText(reference), messageRef: reference };
}

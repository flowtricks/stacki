// Error-message tidying, shared by App and the panels that surface failures.
//
// Lives outside App.tsx on purpose: a module that exports both a component and
// a plain function can't Fast Refresh, so every edit to App.tsx forced Vite
// into a full page reload — which drops the open project and lands you back on
// the dashboard mid-edit.

import type { MessageRef } from '../../shared/core/i18n/messageReference';
import { splitReferencedMessage } from '../../shared/core/i18n/referencedMessage';
import { toRecord } from '../../shared/core/record';

/** A failed call, as a result: the English text and, when the producer sent one, the reference to its own sentence. */
export interface Failure {
  readonly ok: false;
  readonly error: string;
  readonly errorRef?: MessageRef | undefined;
}

/**
 * The text of a failure, with the transport wrapper removed. A reference the producer appended (docs/i18n-playbook.md section 9, thrown
 * refusals) is dropped here, so every reader that has not learned to translate still shows plain English.
 */
export function cleanError(error: unknown): string {
  return splitReferencedMessage(cleanErrorKeepingReference(error)).message;
}

/** Like `cleanError`, but the appended reference stays in the text for `translateErrorText` or `failureOf` to read. */
export function cleanErrorKeepingReference(error: unknown): string {
  const record = toRecord(error);
  const message = record?.['message'];
  const text = typeof message === 'string' && message ? message : String(error);
  return stripAnsi(text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
}

/** A thrown value as a failure result: English `error` and, when its producer referenced a catalog sentence, `errorRef`. */
export function failureOf(error: unknown): Failure {
  const { message, messageRef } = splitReferencedMessage(cleanErrorKeepingReference(error));
  return messageRef === undefined ? { ok: false, error: message } : { ok: false, error: message, errorRef: messageRef };
}

export function stripAnsi(text: unknown): string {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\[(\d{1,2})m/g, '');
}

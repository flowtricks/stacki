// Property-edit refusals that a person reads (docs/i18n-playbook.md, section 7). The property server (electron/properties, also vendored into
// Studio) has no per-user language, so each refusal keeps the English `message` it always had and adds a `messageRef` the window translates.
// A refusal that begins with its own sentence ("Save failed; changes restored." or "src/Card.astro:") carries that sentence as `leadRef`, so
// the sentence and the cause that follows it are each worded in the person's language and joined by a space.
import { assert } from '../core/assert';
import { object, text } from '../core/boundary';
import { parseOptionalMessageRef } from '../core/i18n/messageReference';
import { toRecord } from '../core/record';
import type { MessageParams } from '../core/i18n/catalog';
import type { MessageRef } from '../core/i18n/messageReference';
import type { AppError, Result } from '../core/result';
import { described, messageRef, type Described, type MessageKey } from './i18n/messageRef';

export interface PropertyError extends AppError {
  /** A sentence `message` begins with, kept apart so it is translated beside the cause that follows it. */
  readonly leadRef?: MessageRef | undefined;
}

export type PropertyResult<T> = Result<T, PropertyError>;

/** A refusal worded by a catalog message: `err(refusal('conflict', 'props.edit.conflict'))`. */
export function refusal(code: string, key: MessageKey, params?: MessageParams): PropertyError {
  return { code, ...described(key, params) };
}

/** The refusal with a sentence of its own in front: `message` reads `<lead> <cause>`, and each part has its reference. */
export function withLead(lead: Described, error: PropertyError): PropertyError {
  assert(lead.messageRef !== undefined, 'withLead: the lead sentence has a reference');
  assert(error.leadRef === undefined, 'withLead: a refusal has one lead');
  // Text from the operating system or a compiler has no reference of its own: it travels as the cause's detail.
  const cause = error.messageRef ?? messageRef('props.edit.detail', { detail: error.message });
  return { code: error.code, message: `${lead.message} ${error.message}`, messageRef: cause, leadRef: lead.messageRef };
}

/** The refusal prefixed with the project-relative file it concerns (`src/Card.astro: …`). */
export function inFile(file: string, error: PropertyError): PropertyError {
  return withLead(described('props.edit.inFile', { file }), error);
}

/** Says a message in the person's language: the translation when this window knows `ref`, otherwise `message`. */
export type RefSayer = (message: string, ref: MessageRef | undefined) => string;

/** A refusal as one sentence in the person's language, falling back to its English `message` whenever a part is unknown to this window. */
export function propertyErrorText(error: PropertyError, say: RefSayer): string {
  if (error.leadRef === undefined) {
    return say(error.message, error.messageRef);
  }
  const lead = say('', error.leadRef);
  const cause = say('', error.messageRef);
  return lead === '' || cause === '' ? error.message : `${lead} ${cause}`;
}

/** A refusal that crossed IPC or HTTP: its code and English message, plus the references when they parse (an older producer sends none). */
export function parseRefusal(input: unknown): PropertyError {
  const error = object({ code: text, message: text })(input);
  const wire = toRecord(input);
  const messageRef = parseOptionalMessageRef(wire?.['messageRef']);
  const leadRef = parseOptionalMessageRef(wire?.['leadRef']);
  return { ...error, ...(messageRef === undefined ? {} : { messageRef }), ...(leadRef === undefined ? {} : { leadRef }) };
}

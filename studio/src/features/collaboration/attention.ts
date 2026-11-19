// Why the editor's save status reads "Needs attention", and what a person can do about it.
// The document keeps its status as one English identifier (saveStatus.ts); this module holds the reasons behind that one word, so the
// header can name the single reason, or list several, each with its fix. Pure values in, values out: the document records causes, the
// header draws them.
import type { MenuEntry } from '../../../vendor/stacki/src/ui/menuModel';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

/** The most causes held at once: one per kind, so this is also the number of kinds. */
export const ATTENTION_CAUSES_MAX = 5;
/** The longest server detail shown in the menu; a longer message is cut so one error cannot fill the screen. */
export const ATTENTION_DETAIL_CHARS_MAX = 240;

export type AttentionCause =
  | { readonly kind: 'save-unconfirmed' }
  | { readonly kind: 'draft-failed' }
  | { readonly kind: 'draft-replaced' }
  | { readonly kind: 'file-removed' }
  | { readonly kind: 'edit-failed'; readonly detail: string };

export type AttentionKind = AttentionCause['kind'];

/** What choosing a cause's action does: send the local edits again, or copy them out of the browser. */
export type AttentionAction = 'retry' | 'copy-draft';

export interface AttentionHandlers {
  readonly retry: () => void;
  readonly copyDraft: () => void;
}

/** Adds a cause, replacing one of the same kind (a newer detail wins) and never growing past the bound. */
export function addCause(causes: readonly AttentionCause[], cause: AttentionCause): readonly AttentionCause[] {
  const next = [...causes.filter((existing) => existing.kind !== cause.kind), cause];
  if (next.length > ATTENTION_CAUSES_MAX) {
    throw new Error('Assertion failed: attention causes stay bounded by their kinds');
  }
  return next;
}

/**
 * The cause behind a server `error` message. `messageKey` is the key of the sentence's message reference when it carried one; the two
 * sentences with their own meaning get their own cause, anything else is an edit the server could not apply, shown with its text.
 */
export function causeFromServerError(messageKey: string | undefined, message: string): AttentionCause {
  if (messageKey === 'studio.collab.draftFailed') {
    return { kind: 'draft-failed' };
  }
  if (messageKey === 'studio.collab.fileRemoved') {
    return { kind: 'file-removed' };
  }
  return { kind: 'edit-failed', detail: message.slice(0, ATTENTION_DETAIL_CHARS_MAX) };
}

/** The fix a cause offers, or undefined when only the person can act (open another page). */
export function causeAction(cause: AttentionCause): AttentionAction | undefined {
  switch (cause.kind) {
    case 'save-unconfirmed':
    case 'draft-failed':
    case 'edit-failed':
      return 'retry';
    case 'draft-replaced':
      return 'copy-draft';
    case 'file-removed':
      return undefined;
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/** The short reason: the one cause named when there is exactly one, the generic words when there are several or none. */
export function attentionLabel(causes: readonly AttentionCause[], translate: Translator): string {
  const only = causes.length === 1 ? causes[0] : undefined;
  return only === undefined ? translate('studio.status.needsAttention') : causeTitle(only, translate);
}

/** One heading, one plain-language note and, when there is a fix, one row that does it, for each cause. */
export function attentionEntries(causes: readonly AttentionCause[], translate: Translator, handlers: AttentionHandlers): readonly MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const cause of causes) {
    if (entries.length > 0) {
      entries.push({ kind: 'divider', id: `${cause.kind}:divider` });
    }
    entries.push({ kind: 'heading', id: `${cause.kind}:title`, label: causeTitle(cause, translate) });
    entries.push({ kind: 'note', id: `${cause.kind}:text`, text: causeText(cause, translate) });
    const action = causeAction(cause);
    if (action !== undefined) {
      entries.push({
        kind: 'item',
        id: `${cause.kind}:action`,
        label: actionLabel(cause, translate),
        onSelect: action === 'retry' ? handlers.retry : handlers.copyDraft,
      });
    }
  }
  return entries;
}

function causeTitle(cause: AttentionCause, translate: Translator): string {
  switch (cause.kind) {
    case 'save-unconfirmed':
      return translate('studio.attention.saveUnconfirmed.title');
    case 'draft-failed':
      return translate('studio.attention.draftFailed.title');
    case 'draft-replaced':
      return translate('studio.attention.draftReplaced.title');
    case 'file-removed':
      return translate('studio.attention.fileRemoved.title');
    case 'edit-failed':
      return translate('studio.attention.editFailed.title');
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

function causeText(cause: AttentionCause, translate: Translator): string {
  switch (cause.kind) {
    case 'save-unconfirmed':
      return translate('studio.attention.saveUnconfirmed.text');
    case 'draft-failed':
      return translate('studio.attention.draftFailed.text');
    case 'draft-replaced':
      return translate('studio.attention.draftReplaced.text');
    case 'file-removed':
      return translate('studio.attention.fileRemoved.text');
    case 'edit-failed':
      return translate('studio.attention.editFailed.text', { detail: cause.detail });
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

function actionLabel(cause: AttentionCause, translate: Translator): string {
  switch (cause.kind) {
    case 'save-unconfirmed':
      return translate('studio.attention.saveUnconfirmed.action');
    case 'draft-failed':
      return translate('studio.attention.draftFailed.action');
    case 'draft-replaced':
      return translate('studio.attention.draftReplaced.action');
    case 'edit-failed':
      return translate('studio.attention.editFailed.action');
    case 'file-removed':
      throw new Error('Assertion failed: a removed file offers no action row');
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

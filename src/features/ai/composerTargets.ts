// The open message boxes, by chat, so something outside the panel ("Add to chat", addToChat.ts) can write into
// one at its caret; and where each box's caret was when it closed. The docked panel shares the left column with the
// Code panel and the Navigator, so adding from them opens the box anew: without the memory the chips would always
// land at the end, not where the person left the caret.
import { assert } from '../../../shared/core/assert';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import type { ComposerSegments } from '../../../shared/properties/ai/mentions';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';

/** Rewrites the draft up to the caret, as one edit; the caret ends after what was written. */
export type ComposerEdit = (change: (before: ComposerSegments) => ComposerSegments) => void;

const targets = new Map<ChatId, ComposerEdit>();
const carets = new Map<ChatId, number>();

/** Registers chat `chat`'s open box; the returned function takes it away again. */
export function registerComposerTarget(chat: ChatId, edit: ComposerEdit): () => void {
  targets.set(chat, edit);
  return () => {
    if (targets.get(chat) === edit) {
      targets.delete(chat);
    }
  };
}

export function composerTarget(chat: ChatId): ComposerEdit | undefined {
  return targets.get(chat);
}

export function composerCaretMemory(chat: ChatId): { readonly read: () => number | undefined; readonly write: (caret: number) => void } {
  return {
    read: () => carets.get(chat),
    write: (caret) => {
      assert(Number.isSafeInteger(caret), 'composerCaretMemory: a caret is a document offset');
      // Newest last, so the bound drops the longest unused.
      carets.delete(chat);
      carets.set(chat, caret);
      const oldest = carets.keys().next();
      if (carets.size > AI_LIMITS.draftsStoredMax && oldest.done !== true) {
        carets.delete(oldest.value);
      }
    },
  };
}

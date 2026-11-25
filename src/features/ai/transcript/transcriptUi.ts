// What the person opened or closed in a chat's transcript (an activity group, a tool card, a thought,
// a long message), remembered for the session so a re-render, a scroll or a chat switch does not
// fold away what they were reading. In memory only: a reload starts every card at its default.
//
// A value is `chat` + `key`; an item with no entry takes the chat's bulk choice ("Expand all" /
// "Collapse all" in the chat menu), else the default its component passes. The store is bounded
// (AI_LIMITS.transcriptUiEntriesMax, oldest entry out first), because a long agent run makes
// thousands of cards and the person touches few of them.
import { useCallback, useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';

/** Separates the chat from the item key; a character no chat id or key contains. */
const SEPARATOR = '\u0000';

const entries = new Map<string, boolean>();
const bulk = new Map<string, boolean>();
const listeners = new Set<() => void>();

function entryKey(chat: string, key: string): string {
  return `${chat}${SEPARATOR}${key}`;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Whether the item is open: the person's own choice, else the chat's bulk choice, else `defaults.open`. */
export function openState(chat: string, key: string, defaults: { readonly open: boolean }): boolean {
  const own = entries.get(entryKey(chat, key));
  if (own !== undefined) {
    return own;
  }
  return bulk.get(chat) ?? defaults.open;
}

/** Records the person's choice for one item. */
export function setOpenState(chat: string, key: string, choice: { readonly open: boolean }): void {
  const full = entryKey(chat, key);
  // Re-inserted so a choice just made is the newest and the last to be evicted.
  entries.delete(full);
  entries.set(full, choice.open);
  while (entries.size > AI_LIMITS.transcriptUiEntriesMax) {
    const oldest = entries.keys().next();
    if (oldest.done === true) {
      break;
    }
    entries.delete(oldest.value);
  }
  assert(entries.size <= AI_LIMITS.transcriptUiEntriesMax, 'setOpenState: the remembered states are bounded');
  notify();
}

function setBulk(chat: string, choice: { readonly open: boolean }): void {
  const prefix = `${chat}${SEPARATOR}`;
  for (const full of [...entries.keys()]) {
    if (full.startsWith(prefix)) {
      entries.delete(full);
    }
  }
  bulk.delete(chat);
  bulk.set(chat, choice.open);
  while (bulk.size > AI_LIMITS.chatsMax) {
    const oldest = bulk.keys().next();
    if (oldest.done === true) {
      break;
    }
    bulk.delete(oldest.value);
  }
  notify();
}

/** Opens every group, card and thought in the chat (the chat menu's "Expand all"); a later click on one still wins. */
export function expandAllItems(chat: string): void {
  setBulk(chat, { open: true });
}

/** Folds everything in the chat to its one-line form (the chat menu's "Collapse all"). */
export function collapseAllItems(chat: string): void {
  setBulk(chat, { open: false });
}

/** Forgets everything; for tests and for a project switch. */
export function resetTranscriptUi(): void {
  entries.clear();
  bulk.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open state of one item and the function that changes it; re-renders only when this item's answer changes. */
export function useOpenState(
  chat: string,
  key: string,
  defaults: { readonly open: boolean },
): readonly [boolean, (choice: { readonly open: boolean }) => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => openState(chat, key, defaults),
    () => defaults.open,
  );
  const change = useCallback((choice: { readonly open: boolean }): void => setOpenState(chat, key, choice), [chat, key]);
  return [open, change];
}

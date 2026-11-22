// Find in a chat (⌘F / Ctrl+F while the chat has focus, or the composer's `/find`): the pure rules
// behind the find bar (ChatFindBar.tsx). A match is found in the text the transcript draws, case
// folded; the messages that hold one are opened ("Show more") so the match can be seen; Enter and
// Shift+Enter step through the matches, wrapping at either end.
//
// The composer and the transcript are siblings, so a request to open the bar from the composer goes
// through `requestChatFind`, a counter per chat the transcript watches.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { TranscriptItem } from '../chatReducer';

export const FIND_LIMITS = {
  /** The longest query; a longer one is cut. Why: a pasted page is not a search. */
  queryCharsMax: 200,
  /** Matches counted and highlighted at once; past it the count says "1000+". */
  matchesMax: 1_000,
  /** Messages opened for their matches at once. */
  openedMessagesMax: 200,
  /** Rows the transcript draws while a query is typed, so earlier messages can be found; far below the chat's event bound. */
  rowsShownMax: 2_000,
} as const satisfies Record<string, number>;

/** A match in one text: where it starts and how long it is, in UTF-16 code units. */
export interface TextMatch {
  readonly start: number;
  readonly length: number;
}

/** The query as it is searched for: trimmed of nothing (a space is a character to find) but cut to the bound. */
export function findQuery(input: string): string {
  return input.slice(0, FIND_LIMITS.queryCharsMax);
}

/**
 * Where `query` occurs in `text`, case folded, in order and without overlaps, at most `limit` of them.
 * Folding that changes a text's length (a few letters lower-case to two) would shift every offset, so
 * such a text is searched as it is written.
 */
export function textMatches(text: string, query: string, limit: number = FIND_LIMITS.matchesMax): readonly TextMatch[] {
  assert(limit >= 0, 'textMatches: a limit is a count');
  if (query === '' || limit === 0) {
    return [];
  }
  const folded = text.toLowerCase();
  const foldedQuery = query.toLowerCase();
  const sameLength = folded.length === text.length && foldedQuery.length === query.length;
  const haystack = sameLength ? folded : text;
  const needle = sameLength ? foldedQuery : query;
  const matches: TextMatch[] = [];
  for (let index = haystack.indexOf(needle); index >= 0 && matches.length < limit; index = haystack.indexOf(needle, index + needle.length)) {
    matches.push({ start: index, length: needle.length });
  }
  assert(matches.length <= limit, 'textMatches: the bound holds');
  return matches;
}

/** The ids of the messages (the person's, and the agent's own replies) that hold `query`, oldest first. */
export function matchingMessageIds(items: readonly TranscriptItem[], query: string): readonly number[] {
  if (query === '') {
    return [];
  }
  const ids: number[] = [];
  for (const item of items) {
    if (ids.length >= FIND_LIMITS.openedMessagesMax) {
      break;
    }
    if (isSearchedMessage(item) && textMatches(item.text, query, 1).length > 0) {
      ids.push(item.id);
    }
  }
  assert(ids.length <= FIND_LIMITS.openedMessagesMax, 'matchingMessageIds: the bound holds');
  return ids;
}

/** The match after (or before) `current` among `count`, wrapping at either end; undefined when there is none. */
export function stepMatch(current: number | undefined, count: number, direction: 'next' | 'previous'): number | undefined {
  assert(Number.isSafeInteger(count), 'stepMatch: a count is an integer');
  assert(count >= 0, 'stepMatch: a count is never negative');
  if (count === 0) {
    return undefined;
  }
  if (current === undefined || current >= count) {
    return direction === 'next' ? 0 : count - 1;
  }
  return direction === 'next' ? (current + 1) % count : (current + count - 1) % count;
}

/** The messages a find searches: the drawn words of the conversation, not a thought or a subagent's report. */
function isSearchedMessage(item: TranscriptItem): item is Extract<TranscriptItem, { readonly kind: 'user' | 'text' }> {
  if (item.kind === 'user') {
    return true;
  }
  return item.kind === 'text' && item.role === 'agent' && item.parent === undefined;
}

// ---------------------------------------------------------------------------
// Open requests, from the composer to the transcript.
// ---------------------------------------------------------------------------

const requests = new Map<string, number>();
const listeners = new Set<() => void>();
/** Chats with a pending count; one per chat opened this session is far below it. */
const REQUEST_CHATS_MAX = 1_000;

/** Asks the chat's transcript to open its find bar and focus it. */
export function requestChatFind(chat: string): void {
  requests.set(chat, (requests.get(chat) ?? 0) + 1);
  if (requests.size > REQUEST_CHATS_MAX) {
    const oldest = requests.keys().next();
    if (oldest.done !== true) {
      requests.delete(oldest.value);
    }
  }
  assert(requests.size <= REQUEST_CHATS_MAX, 'requestChatFind: the counters are bounded');
  for (const listener of listeners) {
    listener();
  }
}

/** How many times the chat's find was asked for: the transcript opens the bar each time it grows. */
export function useChatFindRequests(chat: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requests.get(chat) ?? 0,
  );
}

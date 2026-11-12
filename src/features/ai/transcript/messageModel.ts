// The pure rules of message chrome: when a message is long enough to fold behind "Show more", which
// user message may be edited or sent again, and how a timestamp reads. Messages.tsx only draws
// what this module decides.

export const MESSAGE_LIMITS = {
  /** A message with more lines than this folds. */
  clampLines: 40,
  /** A message with more characters than this folds. */
  clampChars: 4_000,
} as const satisfies Record<string, number>;

/** Whether a message is long enough to fold. */
export function exceedsClamp(text: string): boolean {
  if (text.length > MESSAGE_LIMITS.clampChars) {
    return true;
  }
  // Counting breaks stops at the bound, so a message of a million empty lines costs no more than one of forty-one.
  let lines = 1;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    lines += 1;
    if (lines > MESSAGE_LIMITS.clampLines) {
      return true;
    }
  }
  return false;
}

/**
 * The id of the last user message in a transcript, the only one that may be edited or sent again:
 * resending an older one would branch the conversation, which the agent's session cannot do.
 */
export function lastUserMessageId(items: readonly { readonly kind: string; readonly id: number }[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === 'user') {
      return item.id;
    }
  }
  return undefined;
}

/** "2:14 PM" in the person's locale; undefined for a message with no time (stored before timestamps) or a time that is not a date. */
export function timeLabel(at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at) || at <= 0) {
    return undefined;
  }
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The full date and time, for the hover title of a timestamp. */
export function fullTimeLabel(at: number | undefined): string | undefined {
  if (timeLabel(at) === undefined || at === undefined) {
    return undefined;
  }
  return new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

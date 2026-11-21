// "Delete that": the box remembers what each dictated piece added, newest last, so a spoken
// "scratch that" takes exactly that piece back and nothing the person typed. Pure functions
// over a bounded list; the composer keeps the list for the length of one listening session.
import { VOICE_LIMITS } from './voiceLimits';

/** The history with `added` pushed on; the oldest drops when the bound is reached. */
export function pushDictated(history: readonly string[], added: string): readonly string[] {
  if (added === '') {
    return history;
  }
  return [...history, added].slice(-VOICE_LIMITS.historyMax);
}

export interface TakenBack {
  readonly history: readonly string[];
  /** The box's text after the piece is gone; unchanged when the box no longer ends with it. */
  readonly text: string;
  readonly removed: boolean;
}

/**
 * Takes the newest piece off the end of `text`. If the person has typed after it, the box no
 * longer ends with the piece and nothing is removed: "delete that" never reaches into typing.
 */
export function takeBackLast(history: readonly string[], text: string): TakenBack {
  const last = history[history.length - 1];
  if (last === undefined) {
    return { history, text, removed: false };
  }
  if (!text.endsWith(last)) {
    return { history: history.slice(0, -1), text, removed: false };
  }
  return { history: history.slice(0, -1), text: text.slice(0, text.length - last.length).replace(/[ \t]+$/u, ''), removed: true };
}

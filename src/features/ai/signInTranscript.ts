// Which parts of a transcript are one sign-in problem, so the panel draws that
// problem once (the sign-in card) instead of as a raw agent message, a red
// notice and an amber turn end. Pure: the panel reads it on every render.
//
// Three records say the same thing and all three are hidden from the transcript:
//   - a turn that ended with the `sign-in` stop (what the host writes now),
//   - an old `sign-in` notice, with the `error` turn end that followed it (chats
//     stored before the stop existed),
//   - the agent's own message about it ("Failed to authenticate. API Error: 401 …"),
//     which moves behind the card's Details.
import type { TurnId } from '../../../shared/properties/ai/chatModel';
import type { TranscriptItem } from './chatReducer';

/** An agent message about a failed login is a sentence or two; a long one is real output and stays. */
const AUTH_TEXT_CHARS_MAX = 600;
const AUTH_TEXT = /authenticat|\b401\b|oauth|sign[ -]?in|log[ -]?in|token has expired|credential/i;

export interface SignInReading {
  /** Item indexes the transcript does not draw. */
  readonly hidden: ReadonlySet<number>;
  /** The agent's own words about the latest sign-in failure, for the card's Details; undefined when it said none. */
  readonly details: string | undefined;
  /** The latest turn ended on a sign-in failure: its message can be sent again once signed in. */
  readonly interrupted: boolean;
}

export function readSignInFailures(items: readonly TranscriptItem[]): SignInReading {
  const authTurns = new Set<TurnId>();
  const hidden = new Set<number>();
  let latestEnd: number | undefined;
  let latestAuthEnd: number | undefined;
  let waitingForLegacyEnd = false;
  items.forEach((item, index) => {
    if (item.kind === 'notice' && item.severity === 'sign-in') {
      hidden.add(index);
      waitingForLegacyEnd = true;
    } else if (item.kind === 'turn-end') {
      latestEnd = index;
      const legacy = waitingForLegacyEnd && item.stop === 'error';
      waitingForLegacyEnd = false;
      if (item.stop === 'sign-in' || legacy) {
        authTurns.add(item.turn);
        hidden.add(index);
        latestAuthEnd = index;
      }
    }
  });
  const endItem = latestAuthEnd === undefined ? undefined : items[latestAuthEnd];
  const latestTurn = endItem?.kind === 'turn-end' ? endItem.turn : undefined;
  const latestWords: string[] = [];
  items.forEach((item, index) => {
    if (item.kind === 'text' && item.role === 'agent' && authTurns.has(item.turn) && item.text.length <= AUTH_TEXT_CHARS_MAX && AUTH_TEXT.test(item.text)) {
      hidden.add(index);
      if (item.turn === latestTurn) {
        latestWords.push(item.text.trim());
      }
    }
  });
  // The agent's own words first; failing those, the host's message for the turn.
  const details = latestWords.length > 0 ? latestWords.join('\n') : endItem?.kind === 'turn-end' ? endItem.message : undefined;
  return { hidden, details, interrupted: latestAuthEnd !== undefined && latestAuthEnd === latestEnd };
}

// The text a person copies from the recovery screen: what failed, where, and enough of the stack to find it. Pure, so
// what is shown and what is copied are tested without a window.
import { assert } from '../../../shared/core/assert';

export const RECOVERY_DETAILS_LIMITS = {
  /** Characters of the message line; an error message can carry a whole page of text. */
  messageCharsMax: 600,
  /** Characters of the stack and component trace together. */
  traceCharsMax: 6_000,
} as const satisfies Record<string, number>;

export interface RecoveryDetails {
  /** One line naming the failure: what the screen says. */
  readonly message: string;
  /** The text Copy details puts on the clipboard and the log block shows. */
  readonly text: string;
}

/** What a render error looks like to a person: its message, then the stack and the components it passed through. */
export function describeRenderError(error: unknown, componentStack: string | undefined): RecoveryDetails {
  assert(RECOVERY_DETAILS_LIMITS.messageCharsMax > 0, 'A failure keeps at least its message');
  assert(RECOVERY_DETAILS_LIMITS.traceCharsMax > 0, 'A failure keeps a trace');
  const raw = error instanceof Error ? error.message : String(error);
  const message = (raw === '' ? (error instanceof Error ? error.name : 'Error') : raw).split('\n')[0]?.slice(0, RECOVERY_DETAILS_LIMITS.messageCharsMax) ?? '';
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const trace = [stack, componentStack === undefined ? '' : `\nComponent stack:${componentStack}`]
    .join('')
    .slice(0, RECOVERY_DETAILS_LIMITS.traceCharsMax)
    .trim();
  return { message, text: trace === '' ? message : trace };
}

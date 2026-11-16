// Recovering from a page that stopped compiling right after an edit: the compiler's own words
// (file and line included), and whether the failure is close enough to the person's last change to
// offer to take it back. Pure, so the rule is tested without a dev server.
import { assert } from '../../../shared/core/assert';
import type { PreviewHealth } from '../../../shared/ipc/previewHealth';

export const COMPILE_RECOVERY_LIMITS = {
  /** A failure this soon after the app's own write is taken to be that write's doing. */
  afterEditMsMax: 20_000,
  /** Characters of the compiler's message the notice carries; the full text is in the dev log. */
  messageCharsMax: 400,
} as const satisfies Record<string, number>;

/** The message the notice shows, or undefined when the page is healthy or the server said nothing about why. */
export function compileFailureMessage(health: PreviewHealth): string | undefined {
  if (health.kind === 'ok') {
    return undefined;
  }
  const thrown = health.thrown?.trim();
  if (thrown === undefined || thrown === '') {
    return undefined;
  }
  // The compiler names the file and line on the lines after its headline; keep the first few so "where" travels with "what".
  const lines = thrown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const message = lines.slice(0, 3).join(' · ');
  assert(message.length > 0, 'A failure with text has a message');
  return message.length <= COMPILE_RECOVERY_LIMITS.messageCharsMax ? message : `${message.slice(0, COMPILE_RECOVERY_LIMITS.messageCharsMax - 1)}…`;
}

/** Whether a failure at `now` follows the app's own write at `lastWriteAt` closely enough to offer the undo. */
export function failureFollowsEdit(lastWriteAt: number, now: number): boolean {
  assert(Number.isFinite(now), 'The clock reads a number');
  const elapsed = now - lastWriteAt;
  return elapsed >= 0 && elapsed <= COMPILE_RECOVERY_LIMITS.afterEditMsMax;
}

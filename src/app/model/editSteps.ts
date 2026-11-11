// Whether an edit of the open page continues the last undo step or starts its
// own (useHistoryPush in appHistory.ts records through here). Pure, so the rule
// that decides "one undo step or two" is the same in the app and in the tests
// that count steps (test/renderer/apps/appShortcutsOverrides.test.js).
import { assert } from '../../../shared/core/assert';
import type { AppHistory, StepFiles } from '../appTypes';

/** Consecutive edits with one coalesce key closer together than this share a step. */
export const EDIT_COALESCE_WINDOW_MS = 800;

export type EditStepPlacement = 'continue' | 'new';

/**
 * `continue` when the edit joins the last step: the same coalesceKey within
 * EDIT_COALESCE_WINDOW_MS (typing bursts, dropdown hover-scrubs) and the last
 * step is a page edit. Structural edits (no key) always get their own step, and
 * so does a step that made files beside its page writes.
 */
export function editStepPlacement(
  history: Pick<AppHistory, 'past' | 'lastKey' | 'lastPush'>,
  coalesceKey: string | undefined,
  files: StepFiles | undefined,
  nowMs: number,
): EditStepPlacement {
  assert(files === undefined || coalesceKey === undefined, 'A step that made files is a step of its own');
  assert(Number.isFinite(nowMs), 'An edit is timed by a finite clock');
  if (coalesceKey === undefined) {
    return 'new';
  }
  if (coalesceKey !== history.lastKey) {
    return 'new';
  }
  if (nowMs - history.lastPush < EDIT_COALESCE_WINDOW_MS) {
    return history.past[history.past.length - 1]?.kind === 'edits' ? 'continue' : 'new';
  }
  return 'new';
}

// What a canvas click does when the preview-token gate cannot apply it as it
// came (docs/canvas-click.md). The gate (previewGate.ts) exists so that a click
// on a stale rendering never selects whatever node now sits at its path; it
// stays exactly as strict. What changed is what happens next: a refused click
// used to end in a "Click not applied" toast, on every click, for as long as
// the cause lasted. Now each cause has a step on a ladder, and only a cause no
// step can fix reaches the person — once, in plain words, with an action.
//
//   1. retry      the canvas is catching up (an edit rendering, a save landing,
//                 a patch digesting): wait for it, ask the frame again what is
//                 under the same point, judge that answer. Bounded in attempts
//                 and in time.
//   2. reload     retries ran out on a cause a fresh rendering can fix (a
//                 rendering mixing file versions, a missed file change): reload
//                 the canvas once per document. The click is not replayed — the
//                 page under the point is a new one.
//   3. page       the canvas shows markup other than the open file (an error
//                 page, a 404, a redirect, a file the marker could not mark):
//                 select what can be selected safely, the page itself.
//   4. notice     nothing above applies: say so once, offer Reload canvas.
//
// Pure: no timers, no frame, no React. canvasClickRetry.ts runs the ladder.
import { assert } from '../../../shared/core/assert';
import type { FrameRenderProblem, PreviewStaleReason } from '../../../shared/page/previewToken';

export const CANVAS_CLICK_LIMITS = {
  /** Fresh looks one click gets before the ladder moves on. A new rendering
   * prompts a look at once, so a page re-rendering quickly spends looks fast;
   * the window below is the real stop, this the backstop. */
  attemptsMax: 24,
  /** Wall time one click may spend retrying: a slow render on a large page, not a stall. */
  retryWindowMs: 6_000,
  /** The wait before each look, by attempt, the last repeating: short first (a digest), longer later (a save, then a render). */
  retryDelaysMs: [60, 150, 300, 600, 1_000, 1_500],
  /** How long the frame has to answer one look before it counts as silent: a
   * page busy hydrating can hold its main thread past a second. */
  answerTimeoutMs: 2_000,
  /** Canvas reloads the ladder may start for one document. */
  reloadsPerDocumentMax: 1,
  /** How long a notice that was shown stays quiet before it may show again. */
  noticeQuietMs: 60_000,
} as const satisfies Record<string, number | readonly number[]>;

/** Why a click could not be applied as it came. Stable codes: they name each entry of the click log. */
export type CanvasClickProblem =
  /** The gate refused the rendering the click landed on. */
  | {
      readonly kind: 'stale';
      readonly reason: PreviewStaleReason;
      readonly file: string | undefined;
      /** How many files the rendering carried a stamp for, when the frame had announced one: 0 means no marker reached the page at all. */
      readonly stamped: number | undefined;
    }
  /** Main could not be asked (the preview check rejected): nothing vouches for the rendering. */
  | { readonly kind: 'check-failed' }
  /** The frame did not answer a fresh look in time: its bridge is gone or the page is stuck. */
  | { readonly kind: 'frame-silent' }
  /** The click carried no point to look at again (a text session's own click). */
  | { readonly kind: 'no-point' };

/** What the person is told when the ladder runs out. Each says what happened, never that they did something wrong. */
export type CanvasNotice =
  | { readonly kind: 'out-of-step' }
  | { readonly kind: 'other-page'; readonly file: string }
  /** The page rendered with no marker from any project file: something else loaded the files first, or marking failed. */
  | { readonly kind: 'unmarked'; readonly file: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreachable' };

export type CanvasClickStep =
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'reload-canvas' }
  | { readonly kind: 'select-page'; readonly notice: CanvasNotice }
  | { readonly kind: 'drop' }
  | { readonly kind: 'give-up'; readonly notice: CanvasNotice };

export interface CanvasClickProgress {
  /** Fresh looks already taken for this click (0 on its first verdict). */
  readonly attempt: number;
  readonly elapsedMs: number;
  /** Reloads the ladder already started for this document. */
  readonly reloads: number;
}

/** The next step for a click refused with `problem`. `renderProblem` is why the frame announced no token, if it said. */
export function planCanvasClickRecovery(
  problem: CanvasClickProblem,
  progress: CanvasClickProgress,
  renderProblem: FrameRenderProblem | undefined,
): CanvasClickStep {
  assert(Number.isSafeInteger(progress.attempt), 'A click counts its attempts in whole numbers');
  assert(progress.attempt >= 0, 'A click has made no negative attempts');
  assert(progress.reloads >= 0, 'A document has had no negative reloads');
  switch (problem.kind) {
    case 'no-point':
      // Nothing to look at again; the text session that sent it says why itself.
      return DROP;
    case 'check-failed':
      return retryOr(progress, { kind: 'give-up', notice: UNREACHABLE });
    case 'frame-silent':
      return retryOr(progress, reloadOr(progress, { kind: 'give-up', notice: UNREACHABLE }));
    case 'stale':
      return planStale(problem, progress, renderProblem);
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** The step for a refused right-click or double-click: those are not looked at again. A click before them already took the ladder. */
export function planCanvasEventRefusal(problem: CanvasClickProblem, renderProblem: FrameRenderProblem | undefined): CanvasClickStep {
  const exhausted: CanvasClickProgress = { attempt: CANVAS_CLICK_LIMITS.attemptsMax, elapsedMs: 0, reloads: CANVAS_CLICK_LIMITS.reloadsPerDocumentMax };
  const step = planCanvasClickRecovery(problem, exhausted, renderProblem);
  assert(step.kind !== 'retry', 'An exhausted click is not retried');
  assert(step.kind !== 'reload-canvas', 'An exhausted click reloads nothing');
  if (step.kind === 'give-up') {
    // Transient by nature: the canvas caught up a moment later. Saying so on
    // a right-click would be noise; the next one works.
    return step.notice.kind === 'out-of-step' ? DROP : step;
  }
  return step;
}

/** A stable code for a problem, as the click log names it. */
export function canvasClickProblemCode(problem: CanvasClickProblem): string {
  switch (problem.kind) {
    case 'stale':
      // The count of stamped files says whether the page was marked at all; it names no file.
      return problem.stamped === undefined ? `stale:${problem.reason}` : `stale:${problem.reason} stamped-files=${problem.stamped}`;
    case 'check-failed':
    case 'frame-silent':
    case 'no-point':
      return problem.kind;
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** The key two notices share when they say the same thing. */
export function canvasNoticeKey(notice: CanvasNotice): string {
  switch (notice.kind) {
    case 'other-page':
    case 'unmarked':
      return `${notice.kind}:${notice.file}`;
    case 'out-of-step':
    case 'too-large':
    case 'unreachable':
      return notice.kind;
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

/**
 * Which notices may be shown: one at a time, never the same one twice within
 * `noticeQuietMs`, and none while the canvas is healthy. A click that selects
 * clears it (the app dismisses the notice), so a cause that recovered is never
 * reported again for an old click.
 */
export class CanvasNoticeGate {
  private shown: { readonly key: string; readonly atMs: number } | undefined;

  /** Whether `notice` may be shown now; when it may, it is recorded as shown. */
  admit(notice: CanvasNotice, nowMs: number): boolean {
    assert(Number.isFinite(nowMs), 'A notice is admitted at a finite time');
    const key = canvasNoticeKey(notice);
    const shown = this.shown;
    if (shown !== undefined) {
      if (shown.key === key) {
        if (nowMs - shown.atMs < CANVAS_CLICK_LIMITS.noticeQuietMs) {
          return false;
        }
      }
    }
    this.shown = { key, atMs: nowMs };
    return true;
  }

  /** The canvas recovered: true when a notice was up (the app dismisses it). */
  clear(): boolean {
    const had = this.shown !== undefined;
    this.shown = undefined;
    return had;
  }
}

// --- Internal ----------------------------------------------------------------

const DROP: CanvasClickStep = { kind: 'drop' };
const OUT_OF_STEP: CanvasNotice = { kind: 'out-of-step' };
const UNREACHABLE: CanvasNotice = { kind: 'unreachable' };
const TOO_LARGE: CanvasNotice = { kind: 'too-large' };

function planStale(
  problem: Extract<CanvasClickProblem, { readonly kind: 'stale' }>,
  progress: CanvasClickProgress,
  renderProblem: FrameRenderProblem | undefined,
): CanvasClickStep {
  switch (problem.reason) {
    case 'unstamped-file':
      // The canvas shows markup other than the open file: no path in it names
      // a node of that file, now or after any wait. The page is still there.
      if (problem.file === undefined) {
        return { kind: 'select-page', notice: OUT_OF_STEP };
      }
      if (problem.stamped === 0) {
        // Not an error page or a redirect: a rendering with no marker in it at all.
        return { kind: 'select-page', notice: { kind: 'unmarked', file: problem.file } };
      }
      return { kind: 'select-page', notice: { kind: 'other-page', file: problem.file } };
    case 'shown-page-differs':
      // The editor holds edits the canvas has not rendered yet. A save and a
      // render fix it; a reload cannot render unsaved edits sooner.
      return retryOr(progress, { kind: 'give-up', notice: OUT_OF_STEP });
    case 'no-render':
      return planNoRender(progress, renderProblem);
    case 'superseded':
    case 'token-mismatch':
    case 'file-changed':
    case 'file-missing':
      return retryOr(progress, reloadOr(progress, { kind: 'give-up', notice: OUT_OF_STEP }));
    default: {
      const exhaustive: never = problem.reason;
      return exhaustive;
    }
  }
}

// No token: the frame is loading, digesting, or said why it cannot vouch.
function planNoRender(progress: CanvasClickProgress, renderProblem: FrameRenderProblem | undefined): CanvasClickStep {
  if (renderProblem === undefined) {
    return retryOr(progress, reloadOr(progress, { kind: 'give-up', notice: OUT_OF_STEP }));
  }
  switch (renderProblem) {
    case 'conflicting-stamps':
      // A rendering mixing two versions of one file: a fresh rendering has one.
      return retryOr(progress, reloadOr(progress, { kind: 'give-up', notice: OUT_OF_STEP }));
    case 'too-many-stamps':
    case 'page-too-large':
      // Past the manifest's bounds, on every rendering of this page.
      return { kind: 'give-up', notice: TOO_LARGE };
    case 'no-digest':
      return reloadOr(progress, { kind: 'give-up', notice: UNREACHABLE });
    default: {
      const exhaustive: never = renderProblem;
      return exhaustive;
    }
  }
}

function retryOr(progress: CanvasClickProgress, otherwise: CanvasClickStep): CanvasClickStep {
  if (progress.attempt < CANVAS_CLICK_LIMITS.attemptsMax) {
    if (progress.elapsedMs < CANVAS_CLICK_LIMITS.retryWindowMs) {
      const delays = CANVAS_CLICK_LIMITS.retryDelaysMs;
      const delayMs = delays[Math.min(progress.attempt, delays.length - 1)];
      assert(delayMs !== undefined, 'Every attempt below the bound has a delay');
      return { kind: 'retry', delayMs };
    }
  }
  return otherwise;
}

function reloadOr(progress: CanvasClickProgress, otherwise: CanvasClickStep): CanvasClickStep {
  return progress.reloads < CANVAS_CLICK_LIMITS.reloadsPerDocumentMax ? { kind: 'reload-canvas' } : otherwise;
}

// Runs the click ladder (canvasClickRecovery.ts) for the canvas runtime
// (previewRuntime.ts). One click is pending at a time: a newer click replaces
// the one still being retried, so rapid clicks coalesce into the latest intent
// instead of queueing selections that land out of order.
//
// A retry never re-judges the old message. It asks the frame where the same
// point lands now (`avb:click-query`, answered by an `avb:click-node` carrying
// `replay`), and that answer — with the token of the rendering shown now — goes
// through the same gate as any click. The gate's strictness is untouched.
//
// Timers, the frame and the app are injected (CanvasClickRetryHost), so the
// ladder runs under tests with a fake clock.
import { assert } from '../../../shared/core/assert';
import type { FrameRenderProblem } from '../../../shared/page/previewToken';
import {
  CANVAS_CLICK_LIMITS,
  CanvasNoticeGate,
  canvasClickProblemCode,
  planCanvasClickRecovery,
  planCanvasEventRefusal,
  type CanvasClickProblem,
  type CanvasNotice,
} from './canvasClickRecovery';
import { recordCanvasClick, type CanvasClickOutcome } from './canvasClickLog';

/** What the app hears about the canvas's clicks: a notice to show, or that the canvas recovered. */
export type CanvasNoticeEvent = { readonly kind: 'show'; readonly notice: CanvasNotice } | { readonly kind: 'recovered' };

export interface CanvasClickRetryHost {
  readonly nowMs: () => number;
  /** Runs `run` after `delayMs`; returns what cancels it. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  /** Asks the frame what is under the point now (`avb:click-query`). */
  readonly query: (id: number, x: number, y: number) => void;
  /** Selects what is always safe to select: a click on markup the open file does not own. */
  readonly selectPage: () => void;
  readonly reloadCanvas: () => void;
  readonly notice: (event: CanvasNoticeEvent) => void;
  /** Asks the frame to say again which rendering it shows (`avb:request-render`). */
  readonly requestRender: () => void;
}

/** A click the person made, as the ladder needs it. */
export interface CanvasClickPoint {
  readonly x: number | undefined;
  readonly y: number | undefined;
}

// The ladder's ids count up from 1 and wrap well inside the frame's bound
// (frameQueries.ts CLICK_QUERY_ID_MAX), so an id is never reused while live.
const CLICK_ID_MAX = 2 ** 30;

interface PendingClick {
  readonly id: number;
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly startedAtMs: number;
  attempt: number;
  /** What the click waits on: the gate, a delay before the next look, or the frame's answer. */
  phase: 'judging' | 'delay' | 'answer';
  cancel: (() => void) | undefined;
}

export class CanvasClickRetry {
  private pending: PendingClick | undefined;
  private nextId = 1;
  private reloads = 0;
  private renderProblem: FrameRenderProblem | undefined;
  private readonly notices = new CanvasNoticeGate();

  constructor(private readonly host: CanvasClickRetryHost) {}

  /** A click the person made: it replaces any click still being retried. Returns its id. */
  begin(point: CanvasClickPoint): number {
    const previous = this.pending;
    if (previous !== undefined) {
      this.log('replaced', undefined, previous.attempt);
      previous.cancel?.();
    }
    const id = this.nextId;
    this.nextId = id < CLICK_ID_MAX ? id + 1 : 1;
    this.pending = { id, x: point.x, y: point.y, startedAtMs: this.host.nowMs(), attempt: 0, phase: 'judging', cancel: undefined };
    assert(this.pending.id >= 1, 'A click id counts from one');
    return id;
  }

  /** Whether `replay` answers the look this ladder is waiting on; when it does, the click is being judged again. */
  claimReplay(replay: number): boolean {
    const pending = this.pending;
    if (pending === undefined || pending.id !== replay || pending.phase !== 'answer') {
      return false; // An answer for a click a newer one replaced, or one already timed out.
    }
    pending.cancel?.();
    pending.cancel = undefined;
    pending.phase = 'judging';
    return true;
  }

  /** Whether `id` is still the click being decided (a late verdict for a replaced click is not). */
  current(id: number): boolean {
    return this.pending?.id === id && this.pending.phase === 'judging';
  }

  /** The click was applied: the canvas works, so any notice it raised is taken down. */
  succeeded(id: number): void {
    const pending = this.pending;
    assert(pending !== undefined, 'A click that selected was pending');
    assert(pending.id === id, 'The click that selected is the pending one');
    this.log('selected', undefined, pending.attempt);
    this.pending = undefined;
    this.reloads = 0; // A healthy document earns its reload back.
    if (this.notices.clear()) {
      this.host.notice({ kind: 'recovered' });
    }
  }

  /** The click could not be applied: take the next step on the ladder. */
  failed(id: number, problem: CanvasClickProblem): void {
    const pending = this.pending;
    assert(pending !== undefined, 'A refused click was pending');
    assert(pending.id === id, 'The refused click is the pending one');
    const progress = { attempt: pending.attempt, elapsedMs: this.host.nowMs() - pending.startedAtMs, reloads: this.reloads };
    const planned = planCanvasClickRecovery(problem, progress, this.renderProblem);
    // A click with no point cannot be looked at again: what would retry it is a drop.
    const step = planned.kind === 'retry' && !hasPoint(pending) ? planCanvasClickRecovery({ kind: 'no-point' }, progress, this.renderProblem) : planned;
    const code = canvasClickProblemCode(problem);
    switch (step.kind) {
      case 'retry':
        this.log('retrying', code, pending.attempt);
        pending.attempt += 1;
        pending.phase = 'delay';
        pending.cancel = this.host.schedule(step.delayMs, () => this.look(id));
        if (problem.kind === 'stale' && problem.reason === 'no-render') {
          // The frame may have announced its rendering before the editor was
          // listening (a slow start, a reload racing the listener); unasked, it
          // never says it again, and every click waited out the ladder and
          // reloaded. Asking costs one message; the answer prompts the look.
          this.host.requestRender();
        }
        return;
      case 'reload-canvas':
        this.log('reloaded', code, pending.attempt);
        this.pending = undefined;
        this.reloads += 1;
        this.host.reloadCanvas();
        return;
      case 'select-page':
        this.log('selected-page', code, pending.attempt);
        this.pending = undefined;
        this.host.selectPage();
        this.show(step.notice);
        return;
      case 'drop':
        this.log('dropped', code, pending.attempt);
        this.pending = undefined;
        return;
      case 'give-up':
        this.log('gave-up', code, pending.attempt);
        this.pending = undefined;
        this.show(step.notice);
        return;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  }

  /** A right-click or double-click was refused: those are not looked at again (planCanvasEventRefusal). */
  refused(problem: CanvasClickProblem): void {
    const step = planCanvasEventRefusal(problem, this.renderProblem);
    this.log('refused', canvasClickProblemCode(problem), 0);
    if (step.kind === 'give-up' || step.kind === 'select-page') {
      this.show(step.notice);
    }
  }

  /** The frame announced a rendering it vouches for: a click waiting out its delay looks now. */
  rendered(): void {
    this.renderProblem = undefined;
    const pending = this.pending;
    if (pending !== undefined && pending.phase === 'delay') {
      pending.cancel?.();
      pending.cancel = undefined;
      this.look(pending.id);
    }
  }

  /** The frame said why it cannot vouch for what it shows. A mix of file versions is healed by one reload. */
  renderFailed(problem: FrameRenderProblem): void {
    this.renderProblem = problem;
    this.log('render-problem', problem, 0);
    if (problem === 'conflicting-stamps') {
      if (this.reloads < CANVAS_CLICK_LIMITS.reloadsPerDocumentMax) {
        this.reloads += 1;
        this.host.reloadCanvas();
      }
    }
  }

  /** The frame went away (reload, navigation): a pending look has no one to answer it. */
  frameReset(): void {
    const pending = this.pending;
    this.renderProblem = undefined;
    if (pending === undefined) {
      return;
    }
    pending.cancel?.();
    pending.cancel = undefined;
    if (pending.phase === 'judging') {
      return; // Its verdict is still coming; the gate then judges it against the new frame.
    }
    // Waiting to look again: look at the new document once it vouches for itself.
    pending.phase = 'delay';
    pending.cancel = this.host.schedule(CANVAS_CLICK_LIMITS.answerTimeoutMs, () => this.look(pending.id));
  }

  /** Another document: it has its own reload to spend. */
  documentChanged(): void {
    this.reloads = 0;
  }

  dispose(): void {
    this.pending?.cancel?.();
    this.pending = undefined;
  }

  // Asks the frame where the click's point lands now, and waits a bounded time for the answer.
  private look(id: number): void {
    const pending = this.pending;
    if (pending === undefined || pending.id !== id) {
      return;
    }
    const { x, y } = pending;
    assert(x !== undefined, 'Only a click with a point is looked at again');
    assert(y !== undefined, 'Only a click with a point is looked at again');
    pending.phase = 'answer';
    pending.cancel = this.host.schedule(CANVAS_CLICK_LIMITS.answerTimeoutMs, () => {
      if (this.pending?.id === id && this.pending.phase === 'answer') {
        this.pending.phase = 'judging';
        this.pending.cancel = undefined;
        this.failed(id, { kind: 'frame-silent' });
      }
    });
    this.host.query(id, x, y);
  }

  private show(notice: CanvasNotice): void {
    if (this.notices.admit(notice, this.host.nowMs())) {
      this.host.notice({ kind: 'show', notice });
    }
  }

  private log(outcome: CanvasClickOutcome, code: string | undefined, attempt: number): void {
    recordCanvasClick({ atMs: this.host.nowMs(), outcome, code, attempt });
  }
}

function hasPoint(pending: PendingClick): boolean {
  if (pending.x === undefined) {
    return false;
  }
  return pending.y !== undefined;
}

// Keeping the canvas from sitting blank (docs/canvas-recovery.md, "A canvas that goes blank").
//
// canvasRecovery.ts brings the canvas back from an error page the dev server sends. This is for when nothing is sent
// at all: the dev server died, hung or was stopped by someone else, so a reload leaves an empty, see-through frame;
// or the frame's own process died, which Chromium paints as a flat grey box and Electron reports to nobody.
//
// It asks two questions: does the server answer, and do the loaded frames answer? A server that stops answering is
// started again; a frame that stops answering is loaded again. Both are bounded per stretch of time, and when the
// bound is spent the state is `stopped`, which the canvas draws with a Restart preview button. Only the person's own
// asking (that button, or reload) gives the bounds back, so nothing can loop.
//
// The state is a union. One look is in flight at a time, every wait is a timer this owns and clears, and the time,
// the questions and the actions are injected, so the schedule is tested with a fake clock.
import { assert } from '../../../shared/core/assert';
import type { FramesAnswer } from './previewFrames';

export const PREVIEW_SUPERVISOR_LIMITS = {
  /** The wait between looks while all is well. */
  heartbeatMs: 5_000,
  /** The wait before looking again at a miss. */
  confirmMs: 1_500,
  /** Looks without an answer before the server counts as gone. One slow answer is a busy server. */
  serverMissesMax: 3,
  /** The same after the person asked, or a page failed to load: they are looking at a blank canvas. */
  urgentMissesMax: 2,
  /** Looks without an answer from a frame before it is loaded again. */
  frameMissesMax: 2,
  /** Restarts made without being asked, per `restartWindowMs`. */
  restartsMax: 2,
  restartWindowMs: 600_000,
  /** Frame reloads, per `frameReloadWindowMs`. */
  frameReloadsMax: 2,
  frameReloadWindowMs: 300_000,
  /** How long reloaded frames get before they are asked. */
  settleMs: 8_000,
} as const satisfies Record<string, number>;

export type PreviewSupervision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'restarting' }
  /** Nothing more is tried on its own; `server` still notices a server that comes back by itself. */
  | { readonly kind: 'stopped'; readonly cause: 'server' | 'frame' };

export type SupervisorTimerHandle = ReturnType<typeof setTimeout> | number;

export interface PreviewSupervisorTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => SupervisorTimerHandle;
  readonly clearTimeout: (timer: SupervisorTimerHandle | undefined) => void;
  readonly now: () => number;
}

export interface PreviewSupervisorEnvironment {
  /** False while there is no preview to watch: none started yet, or the app is stopping and starting it itself. */
  readonly active: () => boolean;
  readonly visible: () => boolean;
  /** Whether the dev server answers a small request. A rejection counts as no. */
  readonly serverAnswers: () => Promise<boolean>;
  readonly frames: () => Promise<FramesAnswer>;
  /** Starts the dev server again (or finds it running). False, or a rejection, when it did not start. */
  readonly restartServer: () => Promise<boolean>;
  /** Loads the canvas's pages again. */
  readonly reload: () => void;
  readonly onChange: (state: PreviewSupervision) => void;
  readonly timers?: PreviewSupervisorTimers;
}

export interface PreviewSupervisor {
  /** Look now: the window came back, or a page failed to load. */
  readonly check: (reason: 'return' | 'failed') => void;
  /** The person asked for a reload: the bounds are theirs again. */
  readonly asked: () => void;
  /** The dev server's process ended. */
  readonly exited: () => void;
  /** The Restart preview button. */
  readonly restart: () => void;
  readonly state: () => PreviewSupervision;
  readonly stop: () => void;
}

const realTimers: PreviewSupervisorTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  },
  now: () => Date.now(),
};

export function createPreviewSupervisor(environment: PreviewSupervisorEnvironment): PreviewSupervisor {
  const controller = new Supervisor(environment);
  controller.schedule(PREVIEW_SUPERVISOR_LIMITS.heartbeatMs);
  return {
    check: (reason) => controller.check(reason),
    asked: () => controller.asked(),
    exited: () => controller.exited(),
    restart: () => controller.restartAsked(),
    state: () => controller.state,
    stop: () => controller.stop(),
  };
}

class Supervisor {
  state: PreviewSupervision = { kind: 'ok' };
  private readonly timers: PreviewSupervisorTimers;
  private timer: SupervisorTimerHandle | undefined;
  private stopped = false;
  private looking = false;
  private again = false;
  private serverMisses = 0;
  private serverMissesMax: number = PREVIEW_SUPERVISOR_LIMITS.serverMissesMax;
  private frameMisses = 0;
  private restarts: readonly number[] = [];
  private frameReloads: readonly number[] = [];
  // Bumped by a restart, so a look that began before it decides nothing.
  private generation = 0;

  constructor(private readonly environment: PreviewSupervisorEnvironment) {
    this.timers = environment.timers ?? realTimers;
  }

  check(reason: 'return' | 'failed'): void {
    if (this.stopped || this.state.kind === 'restarting') {
      return;
    }
    if (reason === 'failed') {
      this.serverMissesMax = PREVIEW_SUPERVISOR_LIMITS.urgentMissesMax;
    }
    this.schedule(0);
  }

  asked(): void {
    if (this.stopped || this.state.kind === 'restarting') {
      return;
    }
    this.restarts = [];
    this.frameReloads = [];
    if (this.state.kind === 'stopped') {
      void this.restartNow();
    } else {
      this.check('failed');
    }
  }

  exited(): void {
    if (this.stopped || this.state.kind !== 'ok') {
      return;
    }
    void this.restartNow();
  }

  restartAsked(): void {
    if (this.stopped || this.state.kind === 'restarting') {
      return;
    }
    this.restarts = [];
    this.frameReloads = [];
    void this.restartNow();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(delayMs: number): void {
    assert(delayMs >= 0, 'A wait is not negative');
    if (this.stopped) {
      return;
    }
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => void this.look(), delayMs);
  }

  private enter(state: PreviewSupervision): void {
    const before = this.state;
    this.state = state;
    const same = before.kind === state.kind && (before.kind !== 'stopped' || (state.kind === 'stopped' && before.cause === state.cause));
    if (!same) {
      this.environment.onChange(state);
    }
  }

  private async look(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.state.kind === 'restarting') {
      return;
    }
    if (this.looking) {
      this.again = true;
      return;
    }
    if (!this.environment.active()) {
      this.serverMisses = 0;
      this.frameMisses = 0;
      this.enter({ kind: 'ok' });
      this.schedule(PREVIEW_SUPERVISOR_LIMITS.heartbeatMs);
      return;
    }
    // Nobody sees a hidden window; coming back asks at once (`check`).
    if (!this.environment.visible()) {
      this.schedule(PREVIEW_SUPERVISOR_LIMITS.heartbeatMs);
      return;
    }
    this.looking = true;
    const generation = this.generation;
    const next = await this.judge(generation);
    this.looking = false;
    if (next !== undefined && generation === this.generation) {
      this.schedule(this.again ? 0 : next);
    }
    this.again = false;
  }

  // One look. The answer is the wait before the next, or undefined when something else now owns the schedule.
  private async judge(generation: number): Promise<number | undefined> {
    const up = await this.environment.serverAnswers().catch(() => false);
    if (this.stopped || generation !== this.generation) {
      return undefined;
    }
    if (!up) {
      return this.missedServer();
    }
    this.serverMisses = 0;
    this.serverMissesMax = PREVIEW_SUPERVISOR_LIMITS.serverMissesMax;
    if (this.state.kind === 'stopped' && this.state.cause === 'server') {
      // It came back without us: the blank pages are loaded again.
      this.enter({ kind: 'ok' });
      this.environment.reload();
      return PREVIEW_SUPERVISOR_LIMITS.settleMs;
    }
    const frames = await this.environment.frames().catch((): FramesAnswer => 'none');
    if (this.stopped || generation !== this.generation) {
      return undefined;
    }
    return this.judgeFrames(frames);
  }

  private missedServer(): number | undefined {
    this.frameMisses = 0;
    if (this.state.kind === 'stopped') {
      this.enter({ kind: 'stopped', cause: 'server' });
      return PREVIEW_SUPERVISOR_LIMITS.heartbeatMs;
    }
    this.serverMisses += 1;
    if (this.serverMisses < this.serverMissesMax) {
      return PREVIEW_SUPERVISOR_LIMITS.confirmMs;
    }
    void this.restartNow();
    return undefined;
  }

  private judgeFrames(frames: FramesAnswer): number {
    switch (frames) {
      case 'none': {
        return PREVIEW_SUPERVISOR_LIMITS.heartbeatMs;
      }
      case 'answered': {
        this.frameMisses = 0;
        this.enter({ kind: 'ok' });
        return PREVIEW_SUPERVISOR_LIMITS.heartbeatMs;
      }
      case 'silent': {
        if (this.state.kind === 'stopped') {
          return PREVIEW_SUPERVISOR_LIMITS.heartbeatMs;
        }
        this.frameMisses += 1;
        if (this.frameMisses < PREVIEW_SUPERVISOR_LIMITS.frameMissesMax) {
          return PREVIEW_SUPERVISOR_LIMITS.confirmMs;
        }
        this.frameMisses = 0;
        const now = this.timers.now();
        this.frameReloads = this.frameReloads.filter((at) => now - at < PREVIEW_SUPERVISOR_LIMITS.frameReloadWindowMs);
        if (this.frameReloads.length >= PREVIEW_SUPERVISOR_LIMITS.frameReloadsMax) {
          this.enter({ kind: 'stopped', cause: 'frame' });
          return PREVIEW_SUPERVISOR_LIMITS.heartbeatMs;
        }
        this.frameReloads = [...this.frameReloads, now];
        this.environment.reload();
        return PREVIEW_SUPERVISOR_LIMITS.settleMs;
      }
      default: {
        const unreachable: never = frames;
        return unreachable;
      }
    }
  }

  // Starts the server again, as many times as the bound still allows, then gives up out loud.
  private async restartNow(): Promise<void> {
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.generation += 1;
    const generation = this.generation;
    this.serverMisses = 0;
    this.frameMisses = 0;
    this.serverMissesMax = PREVIEW_SUPERVISOR_LIMITS.serverMissesMax;
    for (let attempt = 0; attempt < PREVIEW_SUPERVISOR_LIMITS.restartsMax; attempt += 1) {
      const now = this.timers.now();
      this.restarts = this.restarts.filter((at) => now - at < PREVIEW_SUPERVISOR_LIMITS.restartWindowMs);
      if (this.restarts.length >= PREVIEW_SUPERVISOR_LIMITS.restartsMax) {
        break;
      }
      this.restarts = [...this.restarts, now];
      this.enter({ kind: 'restarting' });
      const started = await this.environment.restartServer().catch(() => false);
      if (this.stopped || generation !== this.generation) {
        return;
      }
      if (started) {
        this.enter({ kind: 'ok' });
        this.environment.reload();
        this.schedule(PREVIEW_SUPERVISOR_LIMITS.settleMs);
        return;
      }
    }
    this.enter({ kind: 'stopped', cause: 'server' });
    this.schedule(PREVIEW_SUPERVISOR_LIMITS.heartbeatMs);
  }
}

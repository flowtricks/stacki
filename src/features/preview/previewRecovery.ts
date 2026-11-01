// A compile-error page has no HMR client. Poll only after a change or a failed
// probe, and reload on the recovering-to-serving edge so ordinary edits keep
// their live patches. One timer and one in-flight probe bound this event loop.
import { assert } from '../../../shared/core/assert';

type Timer = ReturnType<typeof setTimeout> | number;
export interface PreviewTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout: (timer: Timer | undefined) => void;
  readonly now: () => number;
}
interface PreviewOptions {
  readonly probe: () => Promise<{ readonly ok: boolean } | undefined>;
  readonly onRecover: () => void;
  readonly retryMs?: number;
  readonly settleMs?: number;
  readonly quietMs?: number;
  readonly timers?: PreviewTimers | undefined;
}
interface PreviewWatch {
  readonly poke: () => void;
  readonly failed: () => void;
  readonly stop: () => void;
  readonly isServing: () => boolean;
}
// What one probe found: a page being served, or the server still failing to serve one.
type ProbeAnswer = 'serving' | 'failing';
type WatchState = { readonly kind: 'active'; readonly serving: boolean } | { readonly kind: 'stopped'; readonly serving: boolean };

export function createPreviewWatch(options: PreviewOptions): PreviewWatch {
  const watch = new PreviewWatcher(options);
  // Bound methods preserve the original callable API when consumers detach one.
  return {
    poke: () => watch.poke(),
    failed: () => watch.failed(),
    stop: () => watch.stop(),
    isServing: () => watch.isServing(),
  };
}

class PreviewWatcher {
  private state: WatchState = { kind: 'active', serving: true };
  private timer: Timer | undefined;
  private inFlight = false;
  private askedAt = -Infinity;
  private readonly timers: PreviewTimers;
  private readonly retryMs: number;
  private readonly settleMs: number;
  private readonly quietMs: number;

  constructor(private readonly options: PreviewOptions) {
    this.retryMs = options.retryMs ?? 700;
    this.settleMs = options.settleMs ?? 250;
    this.quietMs = options.quietMs ?? 3000;
    for (const duration of [this.retryMs, this.settleMs, this.quietMs]) {
      assert(Number.isSafeInteger(duration), 'Preview interval must be a safe integer');
      assert(duration >= 0, 'Preview interval must be nonnegative');
      assert(duration <= 2_147_483_647, 'Preview interval exceeds timer limit');
    }
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => {
        if (timer !== undefined) {
          globalThis.clearTimeout(timer);
        }
      },
      now: () => Date.now(),
    };
  }

  poke(): void {
    if (this.state.kind === 'stopped') {
      return;
    }
    if (this.state.serving && this.timers.now() - this.askedAt < this.quietMs) {
      return;
    }
    this.schedule(this.settleMs);
  }

  failed(): void {
    if (this.state.kind === 'stopped') {
      return;
    }
    // A successful probe must now reload the failed frame, even if no probe
    // observed the brief outage. Explicit failures also bypass the quiet period.
    this.state = { kind: 'active', serving: false };
    this.schedule(this.settleMs);
  }

  stop(): void {
    this.state = { kind: 'stopped', serving: this.state.serving };
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  isServing(): boolean {
    return this.state.serving;
  }

  private schedule(delayMs: number): void {
    this.timers.clearTimeout(this.timer);
    // Fire and forget: `ask` turns every probe failure into a "failing" answer,
    // so a rejection here could only be a programmer error, which stays loud.
    this.timer = this.timers.setTimeout(() => void this.ask(), delayMs);
  }

  private async ask(): Promise<void> {
    if (this.state.kind === 'stopped' || this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.askedAt = this.timers.now();
    const answer = await this.probe();
    this.inFlight = false;
    this.acceptAnswer(answer);
  }

  private async probe(): Promise<ProbeAnswer> {
    try {
      return (await this.options.probe())?.ok ? 'serving' : 'failing';
    } catch {
      // An unreachable server is also not serving a page; keep recovering.
      return 'failing';
    }
  }

  private acceptAnswer(answer: ProbeAnswer): void {
    if (this.state.kind === 'stopped') {
      return;
    }
    const serving = answer === 'serving';
    const previouslyServing = this.state.serving;
    this.state = { kind: 'active', serving };
    if (!serving) {
      this.schedule(this.retryMs);
    } else if (!previouslyServing) {
      this.options.onRecover();
    }
  }
}

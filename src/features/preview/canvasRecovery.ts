// Getting the canvas back from an error page by itself (docs/canvas-recovery.md).
//
// A page that fails to compile or render is answered with the dev server's own error screen, and that screen carries
// none of the HMR client the real page has: nothing inside it can hear the mistake being fixed. So the canvas sat on
// the error until the person pressed Reload canvas. This controller is the part of the editor that listens instead.
//
// What it knows is deliberately small. It is told about three kinds of news (the canvas failed to load the page; the
// project may have changed; the window came back) and it asks the dev server one question, "can this page be shown?",
// through `inspect`, the same verdict the notice is built from (shared/ipc/previewHealth.ts). It never trusts its own
// earlier answers about whether the canvas is healthy: the old watch assumed "serving" until a failed navigation said
// otherwise, so an error that arrived any other way (a cut-off page, a route with a query string, an error between two
// checks) left it asleep and a later fix was never noticed.
//
// The state is a union: `healthy`, `error` (with where its polling stands) and `recovering` (the reload is issued and
// the new document has not loaded). One check is in flight at a time and the newest request wins; every wait is a timer
// the controller owns and clears. Time, the network and the reload are injected, so the schedule is tested with a
// fake clock and the whole thing is tested against a real dev server.
import { assert } from '../../../shared/core/assert';
import type { PreviewHealth, PreviewHealthKind } from '../../../shared/ipc/previewHealth';

export const CANVAS_RECOVERY_LIMITS = {
  /** After a change is announced, wait this long for the dev server to take it in before asking. */
  settleMs: 250,
  /** While the canvas is healthy, a check no sooner than this after the last one. */
  quietMs: 1_500,
  /** A failure this soon after a change or a restart may be the dev server still compiling, not a verdict. */
  graceMs: 3_000,
  /** How soon a transient failure inside the grace window is looked at again. */
  graceRecheckMs: 400,
  /** Polling stops this long after the error appeared (or after the last change that restarted it); the next change starts it again. */
  pollWindowMs: 120_000,
  /** The wait between polls once the quick ones are used up. */
  pollSteadyMs: 5_000,
  /** The wait between polls while the window is hidden or minimised. */
  hiddenTickMs: 30_000,
  /** A reload that has not loaded by now is forgotten (the frame may never announce it). */
  recoveringMsMax: 10_000,
  /** Recoveries followed by a new failure within `flapWindowMs` that stop the reloading (a page the check likes and the canvas does not). */
  flapsMax: 3,
  flapWindowMs: 60_000,
  /** Characters of an error's first line that identify it. */
  fingerprintCharsMax: 200,
  /** Characters of the dev server's words the notice carries; the full text is in the dev log. */
  messageCharsMax: 400,
} as const satisfies Record<string, number>;

/** The waits between the first polls of an error; every later one is `pollSteadyMs`. */
export const CANVAS_POLL_DELAYS_MS = [400, 800, 1_600, 3_000] as const;

export type RecoveryTrigger = 'write' | 'external' | 'restart' | 'focus' | 'load';

/** What the canvas is showing instead of the page, as the verdict describes it. */
export interface CanvasError {
  readonly kind: PreviewHealthKind;
  readonly status: number;
  /** The words the notice shows; undefined until the dev server has said why. */
  readonly message: string | undefined;
  /** Two errors with the same fingerprint are the same error; a different one updates the notice in place. */
  readonly fingerprint: string;
  /** The page that failed. */
  readonly url: string;
}

export type CanvasPolling =
  | { readonly kind: 'waiting'; readonly attempt: number; readonly dueAt: number }
  | { readonly kind: 'checking'; readonly attempt: number }
  | { readonly kind: 'exhausted' };

export type CanvasHealth =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'error'; readonly error: CanvasError; readonly polling: CanvasPolling; readonly windowEndsAt: number }
  | { readonly kind: 'recovering'; readonly from: CanvasError };

/** What the notice owner hears. `failed` is said once per distinct error, and again when the error changes. */
export type CanvasRecoveryEvent =
  | { readonly kind: 'failed'; readonly error: CanvasError }
  | { readonly kind: 'recovered'; readonly from: CanvasError }
  | { readonly kind: 'gave-up'; readonly error: CanvasError }
  | { readonly kind: 'left' };

/** What a timer hands back: a number in a browser, an object in Node. */
export type CanvasTimerHandle = ReturnType<typeof setTimeout> | number;

export interface CanvasRecoveryTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => CanvasTimerHandle;
  readonly clearTimeout: (timer: CanvasTimerHandle | undefined) => void;
  readonly now: () => number;
}

export interface CanvasRecoveryEnvironment {
  /** The page on show: the route's address, or undefined when no page is open. */
  readonly pageUrl: () => string | undefined;
  /** One verdict on an address. A rejection is read as "unreachable". */
  readonly inspect: (url: string) => Promise<PreviewHealth>;
  /** Shows the page again: a fresh document replaces the error one. */
  readonly reload: () => void;
  /** False while the window is hidden or minimised. */
  readonly visible: () => boolean;
  readonly onEvent: (event: CanvasRecoveryEvent) => void;
  readonly timers?: CanvasRecoveryTimers;
}

export interface CanvasRecovery {
  /** The project may have changed: the app wrote a file, a watcher saw one change, the dev server restarted. */
  readonly trigger: (cause: RecoveryTrigger) => void;
  /** The canvas failed to show `url` (an error status, a navigation that failed). */
  readonly failed: (url: string) => void;
  /** The frame finished loading a document. */
  readonly loaded: () => void;
  /** Another page is on show, or none: forget everything about the old one. */
  readonly pageChanged: () => void;
  /** The window became visible or hidden. */
  readonly visibilityChanged: () => void;
  readonly state: () => CanvasHealth;
  /** Cancels every timer; nothing runs afterwards. */
  readonly stop: () => void;
}

/** The wait before poll number `attempt` (0 is the first poll after the error appeared). */
export function pollDelayMs(attempt: number): number {
  assert(Number.isSafeInteger(attempt), 'A poll attempt is an integer');
  assert(attempt >= 0, 'A poll attempt is not negative');
  return CANVAS_POLL_DELAYS_MS[attempt] ?? CANVAS_RECOVERY_LIMITS.pollSteadyMs;
}

/** The error a verdict describes, or undefined when the page can be shown. */
export function canvasErrorOf(health: PreviewHealth, url: string): CanvasError | undefined {
  if (health.kind === 'ok') {
    return undefined;
  }
  const thrown = health.thrown?.trim();
  const lines = (thrown ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const first = (lines[0] ?? '').slice(0, CANVAS_RECOVERY_LIMITS.fingerprintCharsMax);
  // The compiler names the file and line on the lines after its headline: the first few keep "where" with "what".
  const joined = lines.slice(0, 3).join(' · ');
  const message = joined.length <= CANVAS_RECOVERY_LIMITS.messageCharsMax ? joined : `${joined.slice(0, CANVAS_RECOVERY_LIMITS.messageCharsMax - 1)}…`;
  return {
    kind: health.kind,
    status: health.status,
    message: lines.length === 0 ? undefined : message,
    fingerprint: `${health.kind}|${health.status}|${first}`,
    url,
  };
}

/**
 * Whether a navigation that failed at `failedUrl` is the page on show. The query and the hash do not make it another
 * page (a loop source or a defaults rendering names the same route), a trailing slash does not either, and the dev
 * server's own rendering of the page for the editor (`/__avb/preview`) is the page on show too.
 */
export function isCurrentPageFailure(failedUrl: string, pageUrl: string | undefined): boolean {
  if (pageUrl === undefined) {
    return false;
  }
  let failed: URL;
  let page: URL;
  try {
    failed = new URL(failedUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (failed.origin !== page.origin) {
    return false;
  }
  if (failed.pathname.startsWith('/__avb/preview')) {
    return true;
  }
  const trimmed = (path: string): string => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
  return trimmed(failed.pathname) === trimmed(page.pathname);
}

const UNREACHABLE: PreviewHealth = { kind: 'unreachable', status: 0, thrown: undefined, logTail: '' };

const realTimers: CanvasRecoveryTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  },
  now: () => Date.now(),
};

export function createCanvasRecovery(environment: CanvasRecoveryEnvironment): CanvasRecovery {
  const controller = new CanvasRecoveryController(environment);
  return {
    trigger: (cause) => controller.trigger(cause),
    failed: (url) => controller.failed(url),
    loaded: () => controller.loaded(),
    pageChanged: () => controller.pageChanged(),
    visibilityChanged: () => controller.visibilityChanged(),
    state: () => controller.state,
    stop: () => controller.stop(),
  };
}

class CanvasRecoveryController {
  state: CanvasHealth = { kind: 'healthy' };
  private readonly timers: CanvasRecoveryTimers;
  private timer: CanvasTimerHandle | undefined;
  private recoveringTimer: CanvasTimerHandle | undefined;
  // Bumped whenever the answer to a check in flight would be about something else (another page, a stop).
  private generation = 0;
  private inFlight = false;
  private again = false;
  private stopped = false;
  private lastChangeAt = -Infinity;
  private lastCheckAt = -Infinity;
  private recoveries: number[] = [];

  constructor(private readonly environment: CanvasRecoveryEnvironment) {
    this.timers = environment.timers ?? realTimers;
  }

  trigger(cause: RecoveryTrigger): void {
    if (this.stopped) {
      return;
    }
    const now = this.timers.now();
    if (cause === 'write' || cause === 'external' || cause === 'restart') {
      this.lastChangeAt = now;
    }
    switch (this.state.kind) {
      case 'healthy': {
        // Nothing to look at while hidden; coming back checks.
        if (this.environment.visible()) {
          this.schedule(Math.max(CANVAS_RECOVERY_LIMITS.settleMs, this.lastCheckAt + CANVAS_RECOVERY_LIMITS.quietMs - now));
        }
        return;
      }
      case 'error': {
        // Anything that could have fixed it starts the quick polls again, with a fresh window.
        this.state = { ...this.state, windowEndsAt: now + CANVAS_RECOVERY_LIMITS.pollWindowMs, polling: this.waiting(0, CANVAS_RECOVERY_LIMITS.settleMs) };
        this.schedule(CANVAS_RECOVERY_LIMITS.settleMs);
        return;
      }
      case 'recovering': {
        // The reload in progress may show the old answer: look again once it is done.
        this.again = true;
        return;
      }
      default: {
        const unreachable: never = this.state;
        return unreachable;
      }
    }
  }

  failed(url: string): void {
    if (this.stopped) {
      return;
    }
    const now = this.timers.now();
    switch (this.state.kind) {
      case 'healthy': {
        this.enter({ kind: 'server-error', status: 0, message: undefined, fingerprint: 'pending', url }, now);
        this.schedule(0);
        return;
      }
      case 'recovering': {
        // The new document failed too: count it, so a page the check likes and the canvas does not cannot loop.
        this.recoveries.push(now);
        this.clearRecovering();
        this.enter({ ...this.state.from, url }, now);
        this.schedule(CANVAS_RECOVERY_LIMITS.settleMs);
        return;
      }
      case 'error': {
        this.trigger('load');
        return;
      }
      default: {
        const unreachable: never = this.state;
        return unreachable;
      }
    }
  }

  loaded(): void {
    if (this.stopped) {
      return;
    }
    switch (this.state.kind) {
      case 'recovering': {
        this.clearRecovering();
        this.state = { kind: 'healthy' };
        if (this.again) {
          this.again = false;
          this.schedule(CANVAS_RECOVERY_LIMITS.settleMs);
        }
        return;
      }
      case 'healthy': {
        // A frame that just loaded may be showing an error the navigation did not report: look once.
        this.trigger('load');
        return;
      }
      case 'error': {
        return;
      }
      default: {
        const unreachable: never = this.state;
        return unreachable;
      }
    }
  }

  pageChanged(): void {
    if (this.stopped) {
      return;
    }
    const hadState = this.state.kind !== 'healthy';
    this.reset();
    if (hadState) {
      this.environment.onEvent({ kind: 'left' });
    }
  }

  visibilityChanged(): void {
    if (this.stopped || !this.environment.visible()) {
      return;
    }
    // Back in front: an error looks again now, a healthy canvas takes one look.
    if (this.state.kind === 'error') {
      this.schedule(0);
    } else {
      this.trigger('focus');
    }
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }

  private reset(): void {
    this.generation += 1;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.clearRecovering();
    this.again = false;
    this.state = { kind: 'healthy' };
    this.recoveries = [];
  }

  private enter(error: CanvasError, now: number): void {
    this.state = { kind: 'error', error, windowEndsAt: now + CANVAS_RECOVERY_LIMITS.pollWindowMs, polling: this.waiting(0, CANVAS_RECOVERY_LIMITS.settleMs) };
  }

  private waiting(attempt: number, delayMs: number): CanvasPolling {
    return { kind: 'waiting', attempt, dueAt: this.timers.now() + delayMs };
  }

  private schedule(delayMs: number): void {
    assert(delayMs >= 0, 'A wait is not negative');
    this.timers.clearTimeout(this.timer);
    // Hidden windows poll slowly; one visible again asks at once (visibilityChanged).
    const wait = this.environment.visible() ? delayMs : Math.max(delayMs, CANVAS_RECOVERY_LIMITS.hiddenTickMs);
    this.timer = this.timers.setTimeout(() => void this.check(), wait);
  }

  private async check(): Promise<void> {
    this.timer = undefined;
    if (this.stopped) {
      return;
    }
    if (this.inFlight) {
      this.again = true;
      return;
    }
    const url = this.state.kind === 'error' ? this.state.error.url : this.environment.pageUrl();
    if (url === undefined || this.state.kind === 'recovering') {
      return;
    }
    if (this.state.kind === 'healthy' && !this.environment.visible()) {
      return;
    }
    const generation = this.generation;
    this.inFlight = true;
    this.lastCheckAt = this.timers.now();
    if (this.state.kind === 'error') {
      this.state = { ...this.state, polling: { kind: 'checking', attempt: this.state.polling.kind === 'exhausted' ? 0 : this.state.polling.attempt } };
    }
    let verdict = UNREACHABLE;
    try {
      verdict = await this.environment.inspect(url);
    } catch {
      // A check that could not be made is a server that did not answer.
    }
    this.inFlight = false;
    if (this.stopped || generation !== this.generation) {
      return;
    }
    this.accept(verdict, url);
    if (this.again && !this.isRecovering()) {
      this.again = false;
      this.schedule(CANVAS_RECOVERY_LIMITS.settleMs);
    }
  }

  private accept(verdict: PreviewHealth, url: string): void {
    const now = this.timers.now();
    const error = canvasErrorOf(verdict, url);
    switch (this.state.kind) {
      case 'healthy': {
        if (error === undefined) {
          return;
        }
        if (this.transient(verdict, now)) {
          this.schedule(CANVAS_RECOVERY_LIMITS.graceRecheckMs);
          return;
        }
        this.enter(error, now);
        this.environment.onEvent({ kind: 'failed', error });
        this.scheduleNextPoll(1);
        return;
      }
      case 'error': {
        if (error === undefined) {
          this.recover(this.state.error, now);
          return;
        }
        const before = this.state.error;
        const attempt = this.state.polling.kind === 'checking' ? this.state.polling.attempt : 0;
        this.state = { ...this.state, error };
        if (before.fingerprint !== error.fingerprint) {
          this.environment.onEvent({ kind: 'failed', error });
        }
        this.scheduleNextPoll(attempt + 1);
        return;
      }
      case 'recovering': {
        return;
      }
      default: {
        const unreachable: never = this.state;
        return unreachable;
      }
    }
  }

  private transient(verdict: PreviewHealth, now: number): boolean {
    if (now - this.lastChangeAt > CANVAS_RECOVERY_LIMITS.graceMs) {
      return false;
    }
    switch (verdict.kind) {
      case 'unreachable':
      case 'dropped':
        return true;
      case 'server-error':
        return verdict.thrown === undefined;
      case 'ok':
      case 'empty-page':
      case 'truncated':
      case 'error-overlay':
        return false;
      default: {
        const unreachable: never = verdict.kind;
        return unreachable;
      }
    }
  }

  // `looks` counts the looks made since the error appeared (or since a change restarted the polling); the first
  // look names the error, so the wait after it is the first of the schedule.
  private scheduleNextPoll(looks: number): void {
    assert(looks >= 1, 'A poll follows a look');
    if (this.state.kind !== 'error') {
      return;
    }
    const now = this.timers.now();
    const delayMs = pollDelayMs(looks - 1);
    if (now + delayMs > this.state.windowEndsAt) {
      // The bound: a persistent error is looked at for two minutes, then left until something changes.
      this.state = { ...this.state, polling: { kind: 'exhausted' } };
      this.environment.onEvent({ kind: 'gave-up', error: this.state.error });
      return;
    }
    this.state = { ...this.state, polling: this.waiting(looks, delayMs) };
    this.schedule(delayMs);
  }

  private recover(from: CanvasError, now: number): void {
    this.recoveries = this.recoveries.filter((at) => now - at <= CANVAS_RECOVERY_LIMITS.flapWindowMs);
    if (this.recoveries.length >= CANVAS_RECOVERY_LIMITS.flapsMax) {
      // The check says the page is fine and the canvas keeps failing it: reloading again would flash forever.
      this.state = { kind: 'error', error: from, windowEndsAt: now, polling: { kind: 'exhausted' } };
      this.environment.onEvent({ kind: 'gave-up', error: from });
      return;
    }
    this.state = { kind: 'recovering', from };
    this.environment.onEvent({ kind: 'recovered', from });
    this.environment.reload();
    this.timers.clearTimeout(this.recoveringTimer);
    this.recoveringTimer = this.timers.setTimeout(() => this.loaded(), CANVAS_RECOVERY_LIMITS.recoveringMsMax);
  }

  // A method, so the compiler does not carry the narrowing of `state` across the awaited check.
  private isRecovering(): boolean {
    return this.state.kind === 'recovering';
  }

  private clearRecovering(): void {
    this.timers.clearTimeout(this.recoveringTimer);
    this.recoveringTimer = undefined;
  }
}

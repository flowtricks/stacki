// The container's side of the start report: one small POST to the Worker as each stage begins.
// A report is only for the person watching the boot screen, so it can never delay or fail the
// start: each one is fire-and-forget with its own time limit, a failure is logged and dropped,
// and at most `inFlightMax` are outstanding so a slow Worker cannot pile them up.
import { STARTUP_LIMITS, type StartupStage } from './startupStages';

export const STARTUP_REPORT_LIMITS = {
  /** One report is a few bytes; the Worker answers at once, so this is generous. */
  timeoutMs: 5_000,
  /** There are seven stages; a start never has more than this many reports outstanding. */
  inFlightMax: 8,
} as const satisfies Record<string, number>;

export interface StartupReporterOptions {
  readonly backend: string;
  readonly token: string;
  /** Milliseconds since the container process began (performance.now() in Node). */
  readonly sinceStartMs: () => number;
  readonly post: (url: string, init: RequestInit) => Promise<Response>;
  readonly log: (message: string) => void;
}

export interface StartupReporter {
  report(stage: StartupStage): void;
  /** Resolves when every report sent so far has finished or failed; the tests wait on it. */
  settled(): Promise<void>;
}

export function createStartupReporter(options: StartupReporterOptions): StartupReporter {
  const outstanding = new Set<Promise<void>>();
  return {
    report(stage) {
      if (outstanding.size >= STARTUP_REPORT_LIMITS.inFlightMax) {
        options.log(`Start report for ${stage} skipped: too many outstanding`);
        return;
      }
      const sinceStartMs = Math.min(STARTUP_LIMITS.sinceStartMsMax, Math.max(0, Math.floor(options.sinceStartMs())));
      const sending = options
        .post(options.backend + '/studio/internal/startup', {
          method: 'POST',
          headers: { 'x-studio-token': options.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage, sinceStartMs }),
          signal: AbortSignal.timeout(STARTUP_REPORT_LIMITS.timeoutMs),
        })
        .then(
          (response) => {
            if (!response.ok) {
              options.log(`Start report for ${stage} refused (${response.status})`);
            }
            return response.body?.cancel();
          },
          (error: unknown) => {
            options.log(`Start report for ${stage} failed: ${error instanceof Error ? error.message : 'unknown'}`);
          },
        )
        .then(() => undefined)
        .finally(() => {
          outstanding.delete(sending);
        });
      outstanding.add(sending);
    },
    async settled() {
      await Promise.all([...outstanding]);
    },
  };
}

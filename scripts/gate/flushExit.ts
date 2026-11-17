// Exiting the gate without losing its last words.
//
// `process.exit` ends the process at once, and when standard output is a pipe (every CI runner,
// and `npm test | tee`), writes still queued in it are dropped. That is how Studio verify's real
// error vanished from a Check log: the gate printed the check's output, then exited, and the log
// ended before the output did. Every exit after a failure goes through here: it queues an empty
// write behind everything already written to each stream and exits only when both have drained.
// A bound keeps a stuck pipe from holding the exit forever.

export const FLUSH_LIMITS = {
  drainMsMax: 10_000,
} as const satisfies Record<string, number>;

export interface FlushStream {
  readonly write: (chunk: string, callback: () => void) => boolean;
}

/** Resolves once every write queued on each stream before the call has been handed to the system. */
export function drainStreams(streams: readonly FlushStream[], timer: (callback: () => void, delayMs: number) => void): Promise<'drained' | 'timed-out'> {
  if (streams.length === 0) {
    throw new Error('drainStreams: at least one stream');
  }
  return new Promise((resolve) => {
    let pending = streams.length;
    let settled = false;
    timer(() => {
      if (!settled) {
        settled = true;
        resolve('timed-out');
      }
    }, FLUSH_LIMITS.drainMsMax);
    for (const stream of streams) {
      stream.write('', () => {
        pending -= 1;
        if (pending === 0 && !settled) {
          settled = true;
          resolve('drained');
        }
      });
    }
  });
}

/** Drains standard output and standard error, then exits with the code. Never returns. */
export async function flushAndExit(code: number): Promise<never> {
  if (!Number.isSafeInteger(code)) {
    throw new Error('flushAndExit: the exit code is an integer');
  }
  await drainStreams([process.stdout, process.stderr], (callback, delayMs) => {
    setTimeout(callback, delayMs).unref();
  });
  process.exit(code);
}

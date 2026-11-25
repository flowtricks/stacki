// What the main process does with an error nobody caught.
//
// Electron's default for an uncaught exception in main is a native error box, and for an unhandled rejection a console
// line nobody reads; neither leaves anything behind for the next person who asks "why did it go black". Here both are
// written to the crash log (electron/app/crashLog.ts) with the error's message and its first frames, and the app keeps
// running: most such errors are one failed operation, and ending the process would also end the project's unsaved edits.
// Two bounds keep the guard from becoming the problem: the log is a ring, and the frames kept per error are few.
import { assert } from '../../shared/core/assert';
import type { CrashRecord } from './crashLog';

export const PROCESS_GUARD_LIMITS = {
  /** Lines of an error's stack kept: the message and the frames nearest the throw. */
  stackLinesMax: 8,
} as const satisfies Record<string, number>;

export interface ProcessGuardOptions {
  readonly onUncaughtException: (listener: (error: unknown) => void) => void;
  readonly onUnhandledRejection: (listener: (reason: unknown) => void) => void;
  readonly note: (record: Pick<CrashRecord, 'source' | 'reason' | 'detail'>) => void;
  /** Where the line for a person reading the terminal goes. */
  readonly log: (message: string) => void;
}

/** Registers both guards. Each listener only records: it never throws, since a throw inside it would be the next uncaught exception. */
export function installProcessGuards(options: ProcessGuardOptions): void {
  assert(PROCESS_GUARD_LIMITS.stackLinesMax > 0, 'An error keeps at least its message');
  const record = (kind: 'uncaught exception' | 'unhandled rejection', error: unknown): void => {
    try {
      const described = describeError(error);
      options.log(`[main] ${kind}: ${described.reason}`);
      options.note({ source: 'main-error', reason: `${kind}: ${described.reason}`, detail: described.detail });
    } catch {
      // Nothing left to report to: the guard must not add a second failure to the first.
    }
  };
  options.onUncaughtException((error) => record('uncaught exception', error));
  options.onUnhandledRejection((reason) => record('unhandled rejection', reason));
}

/** An error as the reason (its message) and the detail (its first frames), whatever was thrown. */
export function describeError(error: unknown): { readonly reason: string; readonly detail: string } {
  assert(PROCESS_GUARD_LIMITS.stackLinesMax > 0, 'An error keeps at least its message');
  if (error instanceof Error) {
    const frames = (error.stack ?? '').split('\n').slice(1, PROCESS_GUARD_LIMITS.stackLinesMax);
    return { reason: error.message === '' ? error.name : error.message, detail: frames.join('\n') };
  }
  const text = typeof error === 'string' ? error : describeValue(error);
  return { reason: text === '' ? 'unknown error' : text, detail: '' };
}

function describeValue(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

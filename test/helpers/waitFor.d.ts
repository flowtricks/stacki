// Types for the bounded waits in waitFor.js, so TypeScript tests can use them. The behaviour is documented there.
export interface WaitOptions<T> {
  readonly what: string;
  readonly read: () => T | Promise<T>;
  readonly until: (value: T) => boolean;
  readonly pollCountMax?: number;
  readonly pollIntervalMs?: number;
}

export function waitFor<T>(options: WaitOptions<T>): Promise<T>;
export function waitForSteady<T>(options: WaitOptions<T> & { readonly steadyPollCount?: number }): Promise<T>;

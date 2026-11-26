// What a TypeScript suite uses of the bounded waits (waitFor.js).
export interface WaitOptions<T> {
  readonly what: string;
  readonly read: () => T | Promise<T>;
  readonly until: (value: T) => boolean;
  readonly pollCountMax?: number;
  readonly pollIntervalMs?: number;
}

declare const waits: {
  readonly waitFor: <T>(options: WaitOptions<T>) => Promise<T>;
};

export default waits;

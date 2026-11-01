// Expected failures are values (AGENTS.md §3); programmer errors assert and
// crash (assert.ts). The channels never mix: do not catch an assertion into a
// Result, and do not return err for a violated invariant.

export interface AppError {
  /** Stable machine code — the part a caller can switch on. */
  readonly code: string;
  readonly message: string;
}

export type Result<T, E = AppError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

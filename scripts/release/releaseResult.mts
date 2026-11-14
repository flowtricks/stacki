// The one error channel the release helpers share (AGENTS.md §3). Expected failures, such as a
// network that is down, a gh answer with a missing field, or a version that breaks the patch rule,
// are values the caller must handle; a violated invariant is an assertion and crashes instead.

export interface ReleaseError {
  // A stable machine code, so a test pins the failure without matching prose.
  readonly code: string;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ReleaseError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

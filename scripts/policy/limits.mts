// Every bound the policy tooling holds, in one place (AGENTS.md §5, §10). The
// app's bounds live in shared/core/limits.ts; these bound the tooling itself, so a
// runaway repository or hook payload fails fast instead of hanging a gate.

export const POLICY_LIMITS = {
  /** Files one scan reads. The tree holds about 900 today. */
  scanFilesMax: 20_000,
  /** Bytes read from one file; larger files are reported, not read. */
  fileBytesMax: 4_000_000,
  /** Violations printed in full; the rest are counted. */
  violationsPrintedMax: 200,
  /** Bytes of stdout/stderr kept from one child process. */
  childOutputBytesMax: 8_000_000,
  /** Files handed to one per-edit check. An edit touches a handful. */
  filesPerCheckMax: 200,
  /** Wall-clock budget for one child process (ESLint, tsc, Prettier). */
  childTimeoutMsMax: 300_000,
  /** Bytes accepted on a hook's stdin. Hook payloads are a few kilobytes. */
  hookPayloadBytesMax: 4_000_000,
  /** Times one agent session's stop is refused before it is let through. */
  stopContinuationsMax: 3,
  /** Characters of check output fed back to an agent in one message. */
  feedbackCharsMax: 12_000,
  /** Characters in a commit subject line. */
  commitSubjectCharsMax: 72,
  /**
   * Assertions per function in shared/, averaged. AGENTS.md §9 asks for 2;
   * shared/ measured 0.56 when the scan landed (271 across 482 functions) and
   * 0.57 once the frontmatter source joined shared/ with its invariants
   * asserted (291 across 509). The floor holds what exists and only rises:
   * raise it with each file that gains real invariants, never lower it.
   */
  sharedAssertionsPerFunctionMin: 0.57,
} as const satisfies Record<string, number>;

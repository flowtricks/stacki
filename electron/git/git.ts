// The git runner lib/nodeTools.ts provides (over a PATH it repairs for the packaged
// app), as the git modules here take it. One home: gitSnapshot, gitBranches,
// gitHistory, previewWorktree and contentConfig all shell out through it.

import { toRecord } from '../../shared/core/record';

export interface GitResult {
  readonly stdout: string;
  readonly stderr?: string;
}

/** What a caller may ask of one git run: a longer wait (a commit's hooks, a push). Everything else is the runner's decision. */
export interface GitRunOptions {
  readonly timeout?: number;
}

export type Git = (projectPath: string, args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;

const stderrOf = (error: unknown): string | undefined => {
  const stderr = toRecord(error)?.['stderr'];
  return typeof stderr === 'string' ? stderr : undefined;
};

/** stderr first, then the message — git's own wording leads. */
export function gitErrorDetail(error: unknown): string {
  // `||`, not `??`: an empty stderr falls through to the message, as the
  // untyped code's `err.stderr || err.message` did.
  return stderrOf(error) || (error instanceof Error ? error.message : '');
}

/** Both streams, stdout first — used where git reports conflicts on stdout. */
export function gitErrorFull(error: unknown): string {
  const stdout = toRecord(error)?.['stdout'];
  return `${typeof stdout === 'string' ? stdout : ''}\n${gitErrorDetail(error)}`;
}

import type { ExecFileOptions } from 'node:child_process';
import { err, ok, type Result } from '../../shared/core/result';
import { ensureToolPath, git } from '../lib/nodeTools';

export interface PublishGitError {
  readonly code: 'git';
  readonly message: string;
  readonly exitCode: number | undefined;
}

/** Convert only child-process failures; invariant checks execute outside this boundary. */
export async function runPublishGit(root: string, argumentsList: readonly string[], options: ExecFileOptions = {}): Promise<Result<string, PublishGitError>> {
  ensureToolPath();
  return git(root, argumentsList, options).then(
    (output) => ok(output.stdout),
    (error: unknown) => {
      const exitCode = error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
      // Git errors may embed credential-helper output; only the operation name reaches the UI.
      return err({
        code: 'git',
        message: `Git ${argumentsList[0] ?? 'command'} failed. Check access and try again.`,
        exitCode,
      });
    },
  );
}

export async function readPublishHead(root: string): Promise<Result<string | undefined>> {
  const result = await runPublishGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!result.ok) {
    return result.error.exitCode === 1 ? ok(undefined) : result;
  }
  return parsePublishObject(result.value.trim());
}

export function parsePublishObject(value: string): Result<string> {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? ok(value) : err({ code: 'git-output', message: 'Git returned an invalid object identifier.' });
}

export function publishFilesystemFailure(error: unknown): Result<never> {
  return err({
    code: 'filesystem',
    message: error instanceof Error ? error.message : 'Could not access the publishing files.',
  });
}

import type { ExecFileOptions } from 'node:child_process';
import type { MessageRef } from '../../shared/core/i18n/messageReference';
import { err, ok, type Result } from '../../shared/core/result';
import { ensureToolPath, git } from '../lib/nodeTools';
import { problemOf } from '../../shared/properties/describedError';
import { described } from '../../shared/properties/i18n/messageRef';

export interface PublishGitError {
  readonly code: 'git';
  readonly message: string;
  readonly messageRef?: MessageRef | undefined;
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
        ...described('error.publish.commandFailed', { command: argumentsList[0] ?? 'command' }),
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
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? ok(value) : err({ code: 'git-output', ...described('publish.git.error.invalidObject') });
}

export function publishFilesystemFailure(error: unknown): Result<never> {
  // Stacki's own described refusals keep their reference; operating-system text stays as received.
  return err({
    code: 'filesystem',
    ...(error instanceof Error ? problemOf(error) : described('publish.git.error.filesystem')),
  });
}

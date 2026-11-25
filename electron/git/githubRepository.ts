import type { git } from '../lib/nodeTools';
import { assert } from '../../shared/core/assert';
import { parseGitHubRepository } from '../../shared/ipc/githubRepository';
import type { Result } from '../../shared/core/result';
import { described, type MessageRef } from '../../shared/properties/i18n/messageRef';

/** A failure's English text, plus the reference to our own sentence when git and GitHub did not supply the words. */
export type ConnectResult =
  | { readonly ok: true; readonly value: { readonly url: string; readonly output: string } }
  | { readonly ok: false; readonly error: string; readonly errorRef?: MessageRef | undefined };

export async function connectRepository(execute: typeof git, options: { readonly projectPath: string; readonly repository: string }): Promise<ConnectResult> {
  const repository = parseGitHubRepository(options.repository);
  const url = `https://github.com/${repository}`;
  const command = (args: readonly string[]) => executeCommand(execute, options.projectPath, args);
  const remoteResult = await command(['remote']);
  if (!remoteResult.ok) {
    return remoteResult;
  }
  const remotes = remoteResult.value.stdout.trim().split('\n');
  assert(remotes.length <= 1000, 'Git remote inventory exceeds limit');
  if (remotes.includes('origin')) {
    const exists = described('git.error.originExists');
    return { ok: false, error: exists.message, errorRef: exists.messageRef };
  }
  const branchResult = await command(['symbolic-ref', '--short', 'HEAD']);
  if (!branchResult.ok) {
    return branchResult;
  }
  const branch = branchResult.value.stdout.trim();
  assert(branch.length > 0, 'Publishing requires a named branch');
  const added = await command(['remote', 'add', 'origin', `${url}.git`]);
  if (!added.ok) {
    return added;
  }
  // An ordinary push refuses unrelated or newer remote history. Never force it.
  // Keep the configured remote on failure so Git's normal retry remains available.
  const pushed = await command(['push', '--set-upstream', 'origin', branch]);
  if (!pushed.ok) {
    return pushed;
  }
  return { ok: true, value: { url, output: pushed.value.stdout + pushed.value.stderr } };
}

async function executeCommand(execute: typeof git, projectPath: string, args: readonly string[]): Promise<Result<Awaited<ReturnType<typeof git>>, string>> {
  try {
    return { ok: true, value: await execute(projectPath, args, { timeout: 180000 }) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

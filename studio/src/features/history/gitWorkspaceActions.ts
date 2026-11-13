import { randomUUID } from 'node:crypto';
import { published } from '../publishing/publishFailure';
import { publishGit } from '../publishing/publishGit';
import { gitBranchName, gitWorkspaceBranch } from './gitWorkspaceContract';
import type { GitWorkspaceState } from './gitWorkspace';
import { gitWorkspaceCommit, gitWorkspaceRun, snapshotGitWorkspace, fetchGitWorkspaceHeads } from './gitWorkspaceObjects';
import { mergeGitWorkspace } from './gitWorkspaceMerge';
import { checkpointGitWorkspace } from './gitWorkspaceCheckpoint';
import { ReferencedError } from '../../shared/referencedError';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

export async function pullGitWorkspace(state: GitWorkspaceState) {
  const remote = await fetchGitWorkspaceHeads(gitWorkspaceRun(state.git));
  const target = remote.find((entry) => entry.name === state.manifest.branch);
  if (!target) {
    throw new ReferencedError('git.studio.notPushed');
  }
  const result = await mergeGitWorkspace(state, 'refs/remotes/origin/' + state.manifest.branch, target.head);
  return result.manifest
    ? {
        ...result,
        manifest: {
          ...result.manifest,
          remote,
          branches: [
            ...result.manifest.branches,
            ...remote
              .filter((entry) => !result.manifest.branches.some((local) => local.name === entry.name))
              .map((entry) => ({ ...entry, workspace: randomUUID() })),
          ],
        },
      }
    : { ...result, review: { target: target.head, remote } };
}
export async function parkGitWorkspace(state: GitWorkspaceState) {
  const { git, manifest } = state;
  const current = gitWorkspaceBranch(manifest);
  if (manifest.parked.some((branch) => branch.name === current.name)) {
    throw new ReferencedError('git.studio.parkedExists');
  }
  const run = gitWorkspaceRun(git);
  const tree = await snapshotGitWorkspace(git, current.head);
  const parked = tree !== (await run(['rev-parse', current.head + '^{tree}']));
  const snapshot = await gitWorkspaceCommit(run, tree, [current.head], 'Parked Studio changes');
  return {
    manifest: {
      ...manifest,
      draft: current.head,
      parked: parked ? [...manifest.parked, { name: current.name, head: snapshot }] : manifest.parked,
    },
    target: current.head,
    result: { ok: true, parked, branch: current.name },
  };
}
export async function unparkGitWorkspace(state: GitWorkspaceState) {
  const { manifest, git } = state;
  const waiting = manifest.parked.find((branch) => branch.name === manifest.branch);
  if (!waiting) {
    return { result: { restored: false } };
  }
  const merged = await mergeGitWorkspace(state, manifest.branch, waiting.head);
  if (!merged.manifest || !merged.target) {
    const parkedConflict = described('git.studio.parkedConflict');
    return {
      result: {
        restored: false,
        error: parkedConflict.message,
        errorRef: parkedConflict.messageRef,
      },
    };
  }
  const run = gitWorkspaceRun(git);
  const tree = await run(['rev-parse', merged.target + '^{tree}']);
  const draft = await gitWorkspaceCommit(run, tree, [gitWorkspaceBranch(manifest).head], 'Restored Studio draft');
  return {
    manifest: {
      ...manifest,
      draft,
      parked: manifest.parked.filter((branch) => branch.name !== manifest.branch),
    },
    target: draft,
    result: { restored: true },
  };
}
export async function deleteGitWorkspaceBranch(state: GitWorkspaceState, input: { readonly branch: string; readonly force?: boolean }) {
  const name = gitBranchName(input.branch);
  const { manifest, git } = state;
  if ([manifest.branch, 'main', 'master'].includes(name)) {
    throw new ReferencedError('git.studio.deleteProtected');
  }
  const branch = manifest.branches.find((entry) => entry.name === name);
  if (!branch) {
    throw new ReferencedError('git.studio.branchGone');
  }
  const merged = await publishGit(git, ['merge-base', '--is-ancestor', branch.head, gitWorkspaceBranch(manifest).head]);
  if (!merged.ok && !input.force) {
    return {
      ok: false as const,
      unmerged: true as const,
      ...described('git.action.delete.unmerged', { branch: name }),
    };
  }
  if (merged.ok) {
    published(merged);
  }
  await checkpointGitWorkspace(git, manifest, {
    ...manifest,
    branches: manifest.branches.filter((entry) => entry.name !== name),
  });
  return { ok: true as const };
}

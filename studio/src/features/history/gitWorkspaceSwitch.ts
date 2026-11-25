import { randomUUID } from 'node:crypto';
import type { GitWorkspaceState } from './gitWorkspace';
import { gitBranchName, gitWorkspaceBranch, type GitWorkspaceManifest } from './gitWorkspaceContract';
import { gitWorkspaceRun, snapshotGitWorkspace, gitWorkspaceCommit } from './gitWorkspaceObjects';
import { ReferencedError } from '../../shared/referencedError';

export async function switchGitWorkspace(
  state: GitWorkspaceState,
  input: { readonly branch: string; readonly create?: boolean; readonly parkFirst?: boolean },
) {
  const { git, manifest } = state;
  const name = gitBranchName(input.branch);
  const current = gitWorkspaceBranch(manifest);
  const target = manifest.branches.find((branch) => branch.name === name);
  if (input.create ? target !== undefined : target === undefined) {
    throw new ReferencedError(input.create ? 'git.studio.branchExists' : 'git.studio.branchGone');
  }
  if (input.create && manifest.branches.length >= 64) {
    throw new ReferencedError('git.studio.branchLimit', { max: 64 });
  }
  const run = gitWorkspaceRun(git);
  const tree = await snapshotGitWorkspace(git, current.head);
  const changed = tree !== (await run(['rev-parse', current.head + '^{tree}']));
  const draft = await gitWorkspaceCommit(run, tree, [current.head], 'Studio working draft');
  const parked = manifest.parked.filter((branch) => branch.name !== current.name);
  if (changed && !input.create) {
    parked.push({ name: current.name, head: draft });
  }
  const waiting = manifest.parked.find((branch) => branch.name === name);
  const head = target?.head ?? current.head;
  const next: GitWorkspaceManifest = {
    ...manifest,
    branch: name,
    branches: input.create
      ? [...manifest.branches, { name, head, workspace: randomUUID() }]
      : manifest.branches.map((branch) => (branch.name === name ? { ...branch, workspace: randomUUID() } : branch)),
    parked: parked.filter((branch) => branch.name !== name),
    draft: input.create ? draft : (waiting?.head ?? head),
  };
  return {
    manifest: next,
    target: next.draft ?? head,
    result: {
      ok: true as const,
      from: current.name,
      parked: changed && !input.create,
      restored: waiting !== undefined,
    },
  };
}

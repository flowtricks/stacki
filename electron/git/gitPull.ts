import type { Git } from './git';
import { mergeBranch } from './gitBranches';
import type { MergeOutcome } from './gitBranches';
import { count } from '../../shared/core/boundary';

/** Discover incoming commits without changing the index or working files. */
export async function readIncomingCommits(git: Git, options: { readonly projectPath: string; readonly branch: string }): Promise<number> {
  const { projectPath, branch } = options;
  await git(projectPath, ['check-ref-format', `refs/heads/${branch}`]);
  await requireCurrentBranch(git, options);
  const remoteReference = `refs/heads/${branch}`;
  const advertised = (await git(projectPath, ['ls-remote', '--refs', 'origin', remoteReference])).stdout.trim();
  if (advertised === '') {
    return 0;
  }
  const [commit, reference] = advertised.split('\t');
  if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error('Git returned an invalid remote commit.');
  }
  if (reference !== remoteReference) {
    throw new Error('Git returned a different remote branch.');
  }
  // Fetch objects only when needed. Polling an unchanged branch costs one remote read.
  const available = await git(projectPath, ['cat-file', '-e', `${commit}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!available) {
    // Keep background fetches separate from remote-tracking refs and FETCH_HEAD;
    // they must not change the target of a conflict dialog or another Git operation.
    await git(projectPath, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', commit]);
  }
  await requireCurrentBranch(git, options);
  const output = (await git(projectPath, ['rev-list', '--count', `HEAD..${commit}`])).stdout.trim();
  if (!/^\d+$/.test(output)) {
    throw new Error('Git returned an invalid incoming commit count.');
  }
  return count(Number(output));
}

/** Fetch explicitly so pull conflicts use the editor's existing merge review. */
export async function pullBranch(git: Git, options: { readonly projectPath: string; readonly branch: string }): Promise<MergeOutcome> {
  const { projectPath, branch } = options;
  await git(projectPath, ['check-ref-format', `refs/heads/${branch}`]);
  await requireCurrentBranch(git, options);
  const reference = `refs/remotes/origin/${branch}`;
  // An explicit refspec also works for a branch with no configured upstream.
  // A missing remote branch fails here, before a stale tracking ref can be merged.
  await git(projectPath, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${reference}`]);
  // Network waits must not cause incoming work to land on a different branch.
  await requireCurrentBranch(git, options);
  return mergeBranch(git, { projectPath, branch: reference });
}

async function requireCurrentBranch(git: Git, { projectPath, branch }: { readonly projectPath: string; readonly branch: string }): Promise<void> {
  const current = (await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (current !== branch) {
    throw new Error('The current branch changed. Refresh Git and try pulling again.');
  }
}

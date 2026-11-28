// Publishing a staging branch: the current files are sent to that branch on GitHub and nowhere else. The person's
// branch, index and files are never changed, and nothing is ever forced: the push has no `+`, so GitHub itself
// refuses anything that is not a fast forward.
//
// The branch it pushes can never be production's: not the checked-out branch, not the repository's default branch
// (asked of GitHub at the moment of pushing, and refused when it cannot be told), and not a conventional production
// name. A staging branch holding someone's own commits is refused as diverged. Staging commits Stacki made carry a
// trailer, so the next staging publish (from any computer) may build on them; their history stays in the branch.
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { isProductionBranchName } from '../../shared/properties/publishDestinations';
import { parsePublishObject, runPublishGit } from './publishGitCommand';
import type { PublishRepository } from './publishCommit';
import type { PublishSource } from './publishSnapshot';

const STAGING_TRAILER = 'Stacki-Staging: true';
type Problem = { readonly message: string; readonly messageRef?: Described['messageRef'] };

export interface StagingBranchCheck {
  /** The branch's commit on GitHub, absent until the first staging publish. */
  readonly remoteHead: string | undefined;
}

/** Everything that can be refused before building: a production branch, or a staging branch with other people's work. */
export async function checkStagingBranch(
  root: string,
  repository: PublishRepository,
  branch: string,
  head: string | undefined,
  productionBranches: readonly string[],
): Promise<Result<StagingBranchCheck, Problem>> {
  if (isProductionBranchName(branch, productionBranches)) {
    return err(described('publish.staging.error.sameAsProduction'));
  }
  if (isProductionBranchName(branch, [repository.branch])) {
    return err(described('publish.staging.error.currentBranch', { branch }));
  }
  const options = { env: repository.environment, timeout: 120_000 };
  const symbolic = await runPublishGit(root, ['ls-remote', '--symref', repository.remote, 'HEAD'], options);
  if (!symbolic.ok) {
    return symbolic;
  }
  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symbolic.value)?.[1];
  // In an empty repository the first branch pushed becomes the default one, so staging must never go first.
  if (defaultBranch === undefined) {
    return err(described('publish.staging.error.defaultUnknown'));
  }
  if (isProductionBranchName(branch, [defaultBranch])) {
    return err(described('publish.staging.error.sameAsProduction'));
  }
  const reference = `refs/heads/${branch}`;
  const advertised = await runPublishGit(root, ['ls-remote', '--refs', repository.remote, reference], options);
  if (!advertised.ok) {
    return advertised;
  }
  if (advertised.value.trim() === '') {
    return ok({ remoteHead: undefined });
  }
  const [commit, name] = advertised.value.trim().split('\t');
  const parsed = parsePublishObject(commit ?? '');
  if (!parsed.ok || name !== reference) {
    return err(described('publish.git.error.differentRemote'));
  }
  const fetched = await runPublishGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', repository.remote, parsed.value], options);
  if (!fetched.ok) {
    return fetched;
  }
  if (head !== undefined && (await isAncestor(root, parsed.value, head))) {
    return ok({ remoteHead: parsed.value });
  }
  const message = await runPublishGit(root, ['show', '--no-patch', '--format=%B', parsed.value]);
  if (!message.ok) {
    return message;
  }
  const ours = message.value.split('\n').some((line) => line.trim() === STAGING_TRAILER);
  return ours ? ok({ remoteHead: parsed.value }) : err(described('publish.staging.error.diverged', { branch }));
}

/** Pushes the captured files to the staging branch only. Checked again here, because a build may have taken minutes. */
export async function pushStagingBranch(
  root: string,
  repository: PublishRepository,
  branch: string,
  source: PublishSource,
  productionBranches: readonly string[],
): Promise<Result<undefined, Problem>> {
  const checked = await checkStagingBranch(root, repository, branch, source.head, productionBranches);
  if (!checked.ok) {
    return checked;
  }
  const commit = await stagingCommit(root, source, checked.value.remoteHead);
  if (!commit.ok) {
    return commit;
  }
  if (commit.value === checked.value.remoteHead) {
    return ok(undefined);
  }
  const refspec = `${commit.value}:refs/heads/${branch}`;
  // Tags are never pushed along: a tag can start a production release.
  const pushed = await runPublishGit(root, ['push', '--no-follow-tags', repository.remote, refspec], { env: repository.environment, timeout: 120_000 });
  return pushed.ok ? ok(undefined) : pushed;
}

async function stagingCommit(root: string, source: PublishSource, remoteHead: string | undefined): Promise<Result<string, Problem>> {
  if (remoteHead !== undefined && (await tree(root, remoteHead)) === source.tree) {
    return ok(remoteHead);
  }
  const behind = remoteHead === undefined || (source.head !== undefined && (await isAncestor(root, remoteHead, source.head)));
  if (behind && source.head !== undefined && (await tree(root, source.head)) === source.tree) {
    return ok(source.head);
  }
  // A commit of its own, so uncommitted work reaches staging without being committed to the person's branch.
  const parents = [...(behind ? [] : [remoteHead]), source.head].flatMap((parent) => (parent === undefined ? [] : ['-p', parent]));
  // i18n-ignore: the commit message is written to the repository history, not shown in Stacki.
  const created = await runPublishGit(root, ['commit-tree', source.tree, ...parents, '-m', 'Publish to staging', '-m', STAGING_TRAILER]);
  if (!created.ok) {
    return created;
  }
  return parsePublishObject(created.value.trim());
}

async function isAncestor(root: string, commit: string, descendant: string): Promise<boolean> {
  return (await runPublishGit(root, ['merge-base', '--is-ancestor', commit, descendant])).ok;
}

async function tree(root: string, commit: string): Promise<string | undefined> {
  const result = await runPublishGit(root, ['rev-parse', `${commit}^{tree}`]);
  return result.ok ? result.value.trim() : undefined;
}

// Reviews push an immutable snapshot to a separate branch and leave the draft base alone.
import { publishGit, publishObject, type PublishGit } from '../publishing/publishGit';
import type { PublishSource } from '../publishing/publishSource';
import type { PublishConnection } from '../../shared/publishConnection';
import { err, type Result } from '../../../vendor/stacki/shared/core/result';
import { reviewBranch, type ReviewReceipt } from '../../../vendor/stacki/shared/properties/publishReview';
import { openPublishReview } from '../../../vendor/stacki/electron/project/publishReviewRequest';
import { overlayPublishSource } from './nativePublish';

export async function nativeReview(
  source: PublishSource,
  parent: string,
  connection: PublishConnection,
  options: { readonly localParent?: string } = {},
): Promise<Result<ReviewReceipt>> {
  const git = { ...source.git, authorization: connection.token };
  const remote = `https://github.com/${connection.repository}.git`;
  const fetched = await publishGit(git, ['fetch', '--quiet', '--depth=1', '--filter=blob:none', '--no-tags', remote, 'refs/heads/' + connection.branch]);
  if (!fetched.ok) {
    return fetched;
  }
  const head = await publishGit(git, ['rev-parse', 'FETCH_HEAD']);
  if (!head.ok) {
    return head;
  }
  if (head.value !== parent) {
    return err({
      code: 'github_changed',
      // i18n-ignore: Studio server reply with a stable code, relayed as received.
      message: 'Sync incoming changes before submitting a review.',
    });
  }
  const commitParent = options.localParent ?? parent;
  const ancestor = await publishGit(git, ['merge-base', '--is-ancestor', parent, commitParent]);
  if (!ancestor.ok) {
    // i18n-ignore: Studio server reply with a stable code, relayed as received.
    return err({ code: 'github_changed', message: 'Pull from GitHub before submitting a review.' });
  }
  const original = await publishGit(git, ['rev-parse', commitParent + '^{tree}']);
  if (!original.ok) {
    return original;
  }
  const tree = await overlayPublishSource(git, source, commitParent);
  if (!tree.ok) {
    return tree;
  }
  if (tree.value === original.value && commitParent === parent) {
    // i18n-ignore: Studio server reply with a stable code, relayed as received.
    return err({ code: 'review-empty', message: 'There are no changes to submit for review.' });
  }
  const branch = reviewBranch(parent, tree.value);
  const commit = await nativeReviewCommit(git, remote, branch, tree.value, commitParent);
  if (!commit.ok) {
    return commit;
  }
  return openPublishReview({
    repository: connection.repository,
    token: connection.token,
    base: connection.branch,
    branch,
    sha: commit.value,
  });
}

async function nativeReviewCommit(git: PublishGit, remote: string, branch: string, tree: string, parent: string): Promise<Result<string>> {
  const existing = await publishGit(git, ['ls-remote', '--refs', remote, 'refs/heads/' + branch]);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== '') {
    const commit = publishObject(existing.value.split('\t')[0] ?? '');
    if (!commit.ok) {
      return commit;
    }
    const fetched = await publishGit(git, ['fetch', '--quiet', '--no-tags', remote, commit.value]);
    if (!fetched.ok) {
      return fetched;
    }
    const identity = await publishGit(git, ['show', '--no-patch', '--format=%T %P', commit.value]);
    if (!identity.ok) {
      return identity;
    }
    return identity.value === `${tree} ${parent}`
      ? commit
      : err({
          code: 'review-changed',
          // i18n-ignore: Studio server reply with a stable code, relayed as received.
          message: 'This review branch was changed externally. Review it on GitHub before retrying.',
        });
  }
  const created = await publishGit(git, ['commit-tree', tree, '-p', parent, '-m', 'Submit website changes for review']);
  if (!created.ok) {
    return created;
  }
  const commit = publishObject(created.value);
  if (!commit.ok) {
    return commit;
  }
  const pushed = await publishGit(git, ['push', '--quiet', remote, `${commit.value}:refs/heads/${branch}`]);
  return pushed.ok ? commit : pushed;
}

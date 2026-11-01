// Capture a review commit without staging, committing, or switching the user's branch.
// The branch name identifies its exact parent and tree, making retries idempotent.
import { run } from '../lib/nodeTools';
import { err, ok, type Result } from '../../shared/core/result';
import { reviewBranch, type ReviewReceipt } from '../../shared/properties/publishReview';
import { runPublishGit, parsePublishObject, publishFilesystemFailure } from './publishGitCommand';
import type { PublishSource } from './publishSnapshot';
import type { PublishRepository } from './publishCommit';
import { openPublishReview } from './publishReviewRequest';

export async function submitPublishReview(
  root: string,
  source: PublishSource,
  repository: PublishRepository,
  transport: typeof fetch = fetch,
): Promise<Result<ReviewReceipt>> {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository.remote);
  const name = match?.[1];
  if (!name) {
    return err({ code: 'review', message: 'Reviews require a GitHub repository.' });
  }
  const parent = await reviewBase(root, source, repository);
  if (!parent.ok) {
    return parent;
  }
  const branch = reviewBranch(parent.value, source.tree);
  const commit = await reviewCommit(root, source.tree, parent.value, branch, repository);
  if (!commit.ok) {
    return commit;
  }
  const credential = await reviewCredential(root, repository.environment);
  if (!credential.ok) {
    return credential;
  }
  return openPublishReview(
    {
      repository: name,
      token: credential.value,
      base: repository.branch,
      branch,
      sha: commit.value,
    },
    transport,
  );
}

async function reviewBase(root: string, source: PublishSource, repository: PublishRepository): Promise<Result<string>> {
  const options = { env: repository.environment, timeout: 120000 };
  const advertised = await runPublishGit(root, ['ls-remote', '--refs', repository.remote, 'refs/heads/' + repository.branch], options);
  if (!advertised.ok) {
    return advertised;
  }
  const parent = parsePublishObject(advertised.value.split('\t')[0] ?? '');
  if (!parent.ok) {
    return err({
      code: 'review-base',
      message: 'Push an initial base branch before opening a review.',
    });
  }
  const fetched = await runPublishGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', repository.remote, parent.value], options);
  if (!fetched.ok) {
    return fetched;
  }
  if (source.head === undefined) {
    return err({ code: 'review-base', message: 'Reviews require a committed local base.' });
  }
  const ancestor = await runPublishGit(root, ['merge-base', '--is-ancestor', parent.value, source.head]);
  if (!ancestor.ok) {
    return err({
      code: 'review-base',
      message: 'Pull the latest base branch before submitting a review.',
    });
  }
  const original = await runPublishGit(root, ['rev-parse', parent.value + '^{tree}']);
  if (!original.ok) {
    return original;
  }
  if (original.value.trim() === source.tree) {
    return err({ code: 'review-empty', message: 'There are no changes to submit for review.' });
  }
  return parent;
}

async function reviewCommit(root: string, tree: string, parent: string, branch: string, repository: PublishRepository): Promise<Result<string>> {
  const options = { env: repository.environment, timeout: 120000 };
  const existing = await runPublishGit(root, ['ls-remote', '--refs', repository.remote, 'refs/heads/' + branch], options);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value.trim() !== '') {
    const commit = parsePublishObject(existing.value.split('\t')[0] ?? '');
    if (!commit.ok) {
      return commit;
    }
    const fetched = await runPublishGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', repository.remote, commit.value], options);
    if (!fetched.ok) {
      return fetched;
    }
    const identity = await runPublishGit(root, ['show', '--no-patch', '--format=%T %P', commit.value]);
    if (!identity.ok) {
      return identity;
    }
    return identity.value.trim() === `${tree} ${parent}`
      ? commit
      : err({
          code: 'review-changed',
          message: 'The review branch was changed externally. Review it on GitHub before retrying.',
        });
  }
  const created = await runPublishGit(root, ['commit-tree', tree, '-p', parent, '-m', 'Submit website changes for review']);
  if (!created.ok) {
    return created;
  }
  const commit = parsePublishObject(created.value.trim());
  if (!commit.ok) {
    return commit;
  }
  const pushed = await runPublishGit(root, ['push', repository.remote, `${commit.value}:refs/heads/${branch}`], options);
  return pushed.ok ? commit : pushed;
}

async function reviewCredential(root: string, environment: NodeJS.ProcessEnv): Promise<Result<string>> {
  const configured = environment['GH_TOKEN'];
  if (configured !== undefined) {
    return /^[\w-]{10,512}$/.test(configured) ? ok(configured) : err({ code: 'review-auth', message: 'Invalid GitHub review credential.' });
  }
  const response = await run('gh', ['auth', 'token', '--hostname', 'github.com'], root, {
    env: environment,
    timeout: 30000,
  }).then(ok, publishFilesystemFailure);
  if (!response.ok) {
    return response;
  }
  const token = environment['GH_TOKEN'] ?? response.value.stdout.trim();
  return /^[\w-]{10,512}$/.test(token) ? ok(token) : err({ code: 'review-auth', message: 'Sign in to GitHub before opening a review.' });
}

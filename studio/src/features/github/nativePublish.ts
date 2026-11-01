import assert from 'node:assert/strict';
import { publishGit, publishObject, type PublishGit } from '../publishing/publishGit';
import type { PublishSource } from '../publishing/publishSource';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import type { PublishConnection } from '../../shared/publishConnection';
import { STUDIO_PUBLISH_LIMITS as limits } from '../publishing/publishLimits';

import type { PublishReceipt } from '../../shared/publishSource';
export type { PublishReceipt } from '../../shared/publishSource';

/** Fetch trees, overlay immutable captured blobs, then send only objects missing from the parent. */
export async function nativePublish(source: PublishSource, expectedHead: string, connection: PublishConnection): Promise<Result<PublishReceipt>> {
  assert(/^[a-f0-9]{40}$/.test(expectedHead), 'Publish parent is a validated commit');
  assert(source.files.length <= limits.filesMax, 'Publish manifest is bounded');
  const git = { ...source.git, authorization: connection.token };
  const remote = `https://github.com/${connection.repository}.git`;
  const original = await fetchPublishParent(git, remote, connection.branch, expectedHead);
  if (!original.ok) {
    return original;
  }
  const tree = await overlayPublishSource(git, source, expectedHead);
  if (!tree.ok) {
    return tree;
  }
  if (tree.value === original.value) {
    return ok({
      sha: expectedHead,
      url: `https://github.com/${connection.repository}/commit/${expectedHead}`,
    });
  }
  const committed = await publishGit(git, ['commit-tree', tree.value, '-p', expectedHead, '-m', 'Publish website from Stacki Studio']);
  if (!committed.ok) {
    return committed;
  }
  const identifier = publishObject(committed.value);
  if (!identifier.ok) {
    return identifier;
  }
  // The new commit is a child of the witnessed head. The lease prevents racing updates,
  // including rewinds, without ever replacing another editor's unseen commit.
  const pushed = await publishGit(git, [
    'push',
    '--quiet',
    '--force-with-lease=refs/heads/' + connection.branch + ':' + expectedHead,
    remote,
    identifier.value + ':refs/heads/' + connection.branch,
  ]);
  if (!pushed.ok) {
    return pushed;
  }
  return ok({
    sha: identifier.value,
    url: `https://github.com/${connection.repository}/commit/${identifier.value}`,
  });
}

export async function overlayPublishSource(git: PublishGit, source: PublishSource, parent: string): Promise<Result<string>> {
  assert(source.deleted.length <= 1000, 'Asset deletion manifest is bounded');
  const loaded = await publishGit(git, ['read-tree', parent]);
  if (!loaded.ok) {
    return loaded;
  }
  const entries = source.files.map((file) => `${file.mode} ${file.sha}\t${file.path}\0`);
  for (const file of source.deleted) {
    entries.push(`0 ${'0'.repeat(40)}\t${file}\0`);
  }
  const updated = await publishGit(git, ['update-index', '-z', '--index-info'], entries.join(''));
  if (!updated.ok) {
    return updated;
  }
  const written = await publishGit(git, ['write-tree']);
  return written.ok ? publishObject(written.value) : written;
}

async function fetchPublishParent(git: PublishGit, remote: string, branch: string, expectedHead: string): Promise<Result<string>> {
  const fetched = await publishGit(git, ['fetch', '--quiet', '--depth=1', '--filter=blob:none', '--no-tags', remote, 'refs/heads/' + branch]);
  if (!fetched.ok) {
    return fetched;
  }
  const head = await publishGit(git, ['rev-parse', 'FETCH_HEAD']);
  if (!head.ok) {
    return head;
  }
  if (head.value !== expectedHead) {
    return err({ code: 'github_changed', message: 'GitHub changed before publishing.' });
  }
  return publishGit(git, ['rev-parse', expectedHead + '^{tree}']);
}

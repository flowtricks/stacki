import { mkdir, rm } from 'node:fs/promises';
import { isStudioLocalPath } from '../../../vendor/stacki/shared/properties/studioLocal';
import path from 'node:path';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import { parsePublishConnection } from '../../shared/publishConnection';
import { publishGit, publishObject, type PublishGit } from './publishGit';
import { publishTreeFiles } from './publishSource';
import { publishDisk } from './publishInventory';
import { publishFailure } from './publishFailure';

/** Git writes its download to disk; neither the Worker nor Node buffers a repository archive. */
export async function restorePublishRepository(
  root: string,
  input: unknown,
): Promise<Result<string>> {
  const connection = parsePublishConnection(input);
  if (!connection.ok) {
    return connection;
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    !('sha' in input) ||
    typeof input.sha !== 'string'
  ) {
    return err({ code: 'baseline', message: 'Missing repository baseline.' });
  }
  const baseline = publishObject(input.sha);
  if (!baseline.ok) {
    return baseline;
  }
  const directory = path.join(root, '.stacki/studio/state/bootstrap.git');
  const prepared = await mkdir(directory, { recursive: true, mode: 0o700 }).then(
    ok,
    publishFailure,
  );
  if (!prepared.ok) {
    return prepared;
  }
  const git = { root, directory, authorization: connection.value.token };
  let restored: Result<string>;
  let cleanup: Result<void>;
  try {
    restored = await restorePublishCheckout(git, connection.value.repository, baseline.value);
  } finally {
    cleanup = await rm(directory, { recursive: true, force: true }).then(ok, publishFailure);
  }
  return cleanup.ok ? restored : cleanup;
}

async function restorePublishCheckout(
  git: PublishGit,
  repository: string,
  baseline: string,
): Promise<Result<string>> {
  const initialized = await publishGit(git, ['init', '--bare', git.directory]);
  if (!initialized.ok) {
    return initialized;
  }
  const fetched = await publishGit(git, [
    'fetch',
    '--quiet',
    '--depth=1',
    '--no-tags',
    `https://github.com/${repository}.git`,
    baseline,
  ]);
  if (!fetched.ok) {
    return fetched;
  }
  const files = await publishTreeFiles(git, baseline, { symbolicLinks: 'skip' });
  if (!files.ok) {
    return files;
  }
  if (files.value.some((file) => isStudioLocalPath(file.path.toLowerCase()))) {
    return err({ code: 'path', message: 'Repository cannot contain Studio runtime state.' });
  }
  const bytes = files.value.reduce((total, file) => total + file.size, 0);
  const disk = await publishDisk(git.root, bytes);
  if (!disk.ok) {
    return disk;
  }
  const index = await publishGit(git, ['read-tree', baseline]);
  if (!index.ok) {
    return index;
  }
  // Agent configuration can contain links unrelated to the site. Preserve them in
  // the baseline, but only materialize validated regular files in the runtime.
  const paths = files.value.map((file) => file.path + '\0').join('');
  const checkout = await publishGit(git, ['checkout-index', '--stdin', '-z'], paths);
  return checkout.ok ? ok(baseline) : checkout;
}

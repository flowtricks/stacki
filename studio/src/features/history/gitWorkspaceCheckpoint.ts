import { setGitWorkspaceBusy } from './gitWorkspaceLease';
import { createHash, randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PublishGit } from '../publishing/publishGit';
import { gitWorkspaceRun } from './gitWorkspaceObjects';
import { gitWorkspaceLimits, parseGitWorkspaceManifest, type GitWorkspaceManifest } from './gitWorkspaceContract';
import { saveGitWorkspace } from './gitWorkspaceStorage';

/** Immutable objects upload first; one conditional manifest write publishes the checkpoint. */
export async function checkpointGitWorkspace(
  git: PublishGit,
  previous: GitWorkspaceManifest | undefined,
  next: GitWorkspaceManifest,
): Promise<GitWorkspaceManifest> {
  const run = gitWorkspaceRun(git);
  await replaceGitWorkspaceReferences(git, next);
  const count = Number(await run(['rev-list', '--count', '--branches', '--glob=refs/studio/*', '--not', '--remotes=origin']));
  if (!Number.isSafeInteger(count) || count < 0 || count > 20_000) {
    throw new Error('Too many unpublished Git commits. Push your changes first.');
  }
  const bundle = path.join(git.directory, 'checkpoint.bundle');
  let digest: string | undefined;
  if (count > 0) {
    await run(['bundle', 'create', bundle, '--branches', '--glob=refs/studio/*', '--not', '--remotes=origin']);
    digest = await gitCheckpointDigest(bundle);
  }
  const manifest = parseGitWorkspaceManifest({ ...next, revision: randomUUID(), bundle: digest });
  try {
    await saveGitWorkspace(git.root, manifest, previous, digest ? bundle : undefined);
  } catch (error) {
    // An interrupted remote acknowledgement can have committed. Stop accepting
    // edits until startup recovers the authoritative checkpoint instead of guessing.
    setGitWorkspaceBusy(git.root, 'recovery');
    if (previous) {
      await replaceGitWorkspaceReferences(git, previous);
    }
    throw error;
  } finally {
    await rm(bundle, { force: true });
  }
  return manifest;
}
export async function replaceGitWorkspaceReferences(git: PublishGit, next: GitWorkspaceManifest) {
  const run = gitWorkspaceRun(git);
  const existing = (await run(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/studio', 'refs/remotes'])).split('\n').filter(Boolean);
  if (existing.length > 194) {
    throw new Error('Git reference inventory exceeds its limit.');
  }
  for (const reference of existing) {
    await run(['update-ref', '-d', reference]);
  }
  for (const reference of next.branches) {
    await run(['update-ref', 'refs/heads/' + reference.name, reference.head]);
  }
  for (const reference of next.remote) {
    await run(['update-ref', 'refs/remotes/origin/' + reference.name, reference.head]);
  }
  for (const reference of next.parked) {
    await run(['update-ref', 'refs/studio/parked/' + reference.name, reference.head]);
  }
  if (next.draft) {
    await run(['update-ref', 'refs/studio/draft', next.draft]);
  }
  await run(['symbolic-ref', 'HEAD', 'refs/heads/' + next.branch]);
}
async function gitCheckpointDigest(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > gitWorkspaceLimits.bundleBytes) {
      throw new Error('Unpublished Git work exceeds 96 MiB. Push your changes first.');
    }
    return createHash('sha256')
      .update(await handle.readFile())
      .digest('hex');
  } finally {
    await handle.close();
  }
}

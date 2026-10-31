import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorkspaceManifest } from './gitWorkspaceContract';

export async function pruneLocalGitBundles(
  root: string,
  current: GitWorkspaceManifest,
  previous: GitWorkspaceManifest | undefined,
): Promise<void> {
  const directory = path.join(root, '.stacki/studio/state');
  const names = await readdir(directory);
  if (names.length > 10_000) {
    throw new Error('Studio state inventory exceeds its limit.');
  }
  const keep = new Set([current.bundle, previous?.bundle]);
  for (const name of names) {
    if (/^[a-f0-9]{64}\.bundle$/.test(name) && !keep.has(name.slice(0, -7))) {
      await rm(path.join(directory, name), { force: true });
    }
  }
}

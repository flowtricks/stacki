import { readGitWorkspace } from '../history/gitWorkspaceStorage';
import { gitWorkspaceBranch } from '../history/gitWorkspaceContract';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { record } from '../../shared/primitiveValidation';
import { parseWorkspaceId } from '../../shared/workspaceIdentity';

export async function readWorkspaceId(root: string): Promise<string | undefined> {
  const workspace = await readGitWorkspace(root);
  if (workspace) {
    const namespace = gitWorkspaceBranch(workspace).workspace;
    if (namespace !== 'legacy') {
      return 'git-' + namespace;
    }
  }
  const handle = await open(path.join(root, 'package.json'), 'r').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (handle === undefined) {
    return undefined;
  }
  try {
    // A manifest is small; refuse oversized input before allocating its contents.
    if ((await handle.stat()).size > 1_000_000) {
      throw new Error('Project manifest exceeds 1 MB limit');
    }
    const manifest: unknown = JSON.parse(await handle.readFile('utf8'));
    const studio = record(manifest)['studio'];
    return studio === undefined ? undefined : parseWorkspaceId(record(studio)['workspaceId']);
  } finally {
    await handle.close();
  }
}

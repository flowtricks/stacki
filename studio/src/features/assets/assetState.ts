import { gitDraftHeaders } from '../history/gitWorkspaceStorage';
import { mkdir, readFile, rename, writeFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { safePath } from '../project/projectServer';
import { emptyAssetState, parseAssetState, type AssetState } from './assetStateTypes';

export async function readAssetState(root: string): Promise<AssetState> {
  try {
    return parseAssetState(JSON.parse(await readFile(statePath(root), 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyAssetState;
    }
    throw error;
  }
}
export async function saveAssetState(root: string, state: AssetState) {
  const body = JSON.stringify(parseAssetState(state));
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (backend) {
    const response = await fetch(backend + '/studio/internal/asset-state', {
      method: 'PUT',
      headers: await gitDraftHeaders(root),
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error('Could not persist asset changes');
    }
  }
  await writeLocalState(root, body);
}
export async function restoreAssetState(root: string) {
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (backend) {
    const response = await fetch(backend + '/studio/internal/asset-state', {
      headers: await gitDraftHeaders(root),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error('Could not restore asset changes');
    }
    await writeLocalState(root, JSON.stringify(parseAssetState(await response.json())));
  }
  const state = await readAssetState(root);
  for (const file of state.deleted) {
    await rm(await safePath(root, file), { force: true });
  }
  for (const directory of [...state.removedDirectories].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(await safePath(root, directory));
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTEMPTY'].includes(String(error.code))
      )) {
        throw error;
      }
    }
  }
  for (const directory of state.directories) {
    await mkdir(await safePath(root, directory), { recursive: true });
  }
}
async function writeLocalState(root: string, body: string) {
  await mkdir(path.dirname(statePath(root)), { recursive: true });
  await writeFile(statePath(root) + '.tmp', body);
  await rename(statePath(root) + '.tmp', statePath(root));
}
function statePath(root: string) {
  return path.join(root, '.stacki/studio/state/asset-state.json');
}

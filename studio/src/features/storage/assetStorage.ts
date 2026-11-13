import { ReferencedError } from '../../shared/referencedError';
import { gitDraftHeaders } from '../history/gitWorkspaceStorage';
import { MEDIA_EXT } from '../assets/assetStateTypes';
import { keepLocalUpload, localUploadPath } from './cleanupStore';
import { writeFile, rename, stat, rm } from 'node:fs/promises';
import { preparePath, safePath, walk } from '../project/projectServer';
import { filePath } from '../../shared/validation';

export async function saveAsset(root: string, file: string, bytes: Uint8Array) {
  filePath(file);
  if (bytes.length > 20_000_000) {
    throw new ReferencedError('assets.error.tooBig', { size: 20 });
  }
  const inventory = [...(await walk(root, 'public')), ...(await walk(root, 'src')).filter((file) => MEDIA_EXT.test(file))];
  const sizes = await Promise.all(inventory.filter((item) => item !== file).map(async (item) => (await stat(await safePath(root, item))).size));
  if (inventory.length >= 200 || sizes.reduce((total, size) => total + size, bytes.length) > 100_000_000) {
    throw new ReferencedError('assets.error.allowance');
  }
  const destination = await preparePath(root, file);
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (backend) {
    const response = await fetch(backend + '/studio/internal/asset?file=' + encodeURIComponent(file), {
      method: 'PUT',
      headers: await gitDraftHeaders(root),
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new ReferencedError('assets.error.storageSaveFailed');
    }
  }
  if (!backend) {
    await keepLocalUpload(root, file, bytes);
  }
  await writeFile(destination + '.studio-tmp', bytes);
  await rename(destination + '.studio-tmp', destination);
}

export async function forgetAsset(root: string, file: string) {
  filePath(file);
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (backend) {
    const response = await fetch(backend + '/studio/internal/asset?file=' + encodeURIComponent(file), {
      method: 'DELETE',
      headers: await gitDraftHeaders(root),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new ReferencedError('assets.error.storageRemoveFailed');
    }
  } else {
    await rm(localUploadPath(root, file), { force: true });
  }
}

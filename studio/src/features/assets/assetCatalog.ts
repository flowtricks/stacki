import path from 'node:path';
import { batchedRead } from '../../shared/batchedRead';
import { stat, readdir } from 'node:fs/promises';
import { safePath, walk } from '../project/projectServer';
import { MEDIA_EXT } from './assetStateTypes';
import { readAssetState } from './assetState';
import type { WireAssetEntry } from '../../../vendor/stacki/shared/ipc/ipcResults';
import { projectFoldersFor } from '../../../vendor/stacki/electron/lib/projectFolders';
import { folderHolding, isAboveFolder } from '../../../vendor/stacki/shared/properties/projectFolders';

export async function assetCatalog(root: string) {
  // Which folders under public/ and src/ hold assets is the project's choice
  // (.stacki/folders.json); by default, all of both, as Desktop lists them.
  const folders = projectFoldersFor(root, 'assets');
  const listed = (rel: string) => folderHolding(folders, rel) !== undefined || isAboveFolder(folders, rel);
  const files = [...(await walk(root, 'public')), ...(await walk(root, 'src'))].filter(
    (file) => MEDIA_EXT.test(file) && folderHolding(folders, file) !== undefined,
  );
  const state = await readAssetState(root);
  const directories = new Set<string>(state.directories.filter(listed));
  // Include the default folders even when empty; file discovery cannot infer them.
  for (const rootName of new Set(['public', 'src', 'src/assets', 'src/assets/images', ...folders].filter(listed))) {
    try {
      await readdir(path.dirname(await safePath(root, rootName + '/asset-probe')));
      directories.add(rootName);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  const filesRead = await batchedRead(files, async (file): Promise<WireAssetEntry> => {
    const info = await stat(await safePath(root, file));
    const parent = file.split('/').slice(0, -1).join('/');
    const parts = parent.split('/');
    for (let index = 1; index <= parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
    return {
      rel: file,
      abs: file,
      name: file.split('/').at(-1) ?? file,
      parent,
      root: parts[0] ?? '',
      isDir: false,
      size: info.size,
    };
  });
  // A configured folder deeper than its root is reached through the folders above it.
  for (const directory of [...directories]) {
    const parts = directory.split('/');
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  const entries: WireAssetEntry[] = [...filesRead];
  for (const directory of [...directories].sort()) {
    const parts = directory.split('/');
    entries.push({
      rel: directory,
      name: parts.at(-1) ?? directory,
      parent: parts.slice(0, -1).join('/'),
      root: parts[0] ?? '',
      isDir: true,
      ...(parts.length === 1 ? { isRoot: true } : {}),
    });
  }
  return { entries, missing: !directories.has('public') };
}

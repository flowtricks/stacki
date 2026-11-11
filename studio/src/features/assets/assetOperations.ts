import { assetDirectoryContents } from './assetDirectories';
import { access, mkdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { safePath } from '../project/projectServer';
import { saveAsset, forgetAsset } from '../storage/assetStorage';
import { filePath, record, string } from '../../shared/validation';
import { managedAsset } from './assetStateTypes';
import { assetFolderPath } from './assetFolders';
import { readAssetState, saveAssetState } from './assetState';

export async function mutateAsset(root: string, input: unknown) {
  const value = record(input);
  const kind = string(value['kind'], 12);
  const rel = directoryOrFile(value['rel']);
  if (kind === 'mkdir') {
    const destination = assetFolderPath(root, child(rel, value['name']));
    await vacant(root, destination);
    const state = await readAssetState(root);
    await saveAssetState(root, {
      ...state,
      directories: [...state.directories, destination],
      removedDirectories: state.removedDirectories.filter((item) => item !== destination),
    });
    await mkdir(await safePath(root, destination), { recursive: true });
    return { ok: true };
  }
  filePath(rel); // Root directories cannot be renamed, moved, or deleted.
  assetFolderPath(root, rel);
  const source = await safePath(root, rel);
  const info = await stat(source);
  if (kind === 'delete') {
    managedAsset(rel);
    if (!info.isFile()) {
      throw new Error('Only files can be deleted');
    }
    const state = await readAssetState(root);
    await saveAssetState(root, { ...state, deleted: [...state.deleted, rel] });
    await rm(source);
    await forgetAsset(root, rel);
    return { ok: true };
  }
  const destination =
    kind === 'rename'
      ? child(path.posix.dirname(rel), value['name'])
      : kind === 'move'
        ? child(directoryOrFile(value['destination']), path.posix.basename(rel))
        : undefined;
  if (!destination) {
    throw new Error('Unknown asset operation');
  }
  if (destination === rel) {
    return { ok: true };
  }
  assetFolderPath(root, destination);
  if (destination.startsWith(rel + '/')) {
    throw new Error('A folder cannot be moved into itself');
  }
  await vacant(root, destination);
  await relocate(root, rel, destination, info.isDirectory());
  return { ok: true };
}
async function relocate(root: string, rel: string, destination: string, directory: boolean) {
  const contents = directory ? await assetDirectoryContents(root, rel) : { files: [rel], directories: [] };
  const { files } = contents;
  if (files.length > 200) {
    throw new Error('Move at most 200 assets at once');
  }
  for (const file of files) {
    managedAsset(file);
    managedAsset(destination + file.slice(rel.length));
    if ((await stat(await safePath(root, file))).size > 20_000_000) {
      throw new Error('Asset exceeds 20 MB');
    }
  }
  const state = await readAssetState(root);
  for (const file of files) {
    const target = destination + file.slice(rel.length);
    await saveAsset(root, target, await readFile(await safePath(root, file)));
  }
  const targets = files.map((file) => destination + file.slice(rel.length));
  const directories = state.directories.map((item) => (item === rel || item.startsWith(rel + '/') ? destination + item.slice(rel.length) : item));
  await saveAssetState(root, {
    deleted: [...state.deleted.filter((file) => !targets.includes(file)), ...files],
    directories: [...directories, ...contents.directories.map((item) => destination + item.slice(rel.length))],
    removedDirectories: directory
      ? [...state.removedDirectories.filter((item) => item !== destination && !item.startsWith(destination + '/')), ...contents.directories]
      : state.removedDirectories,
  });
  for (const file of files) {
    await rm(await safePath(root, file));
    await forgetAsset(root, file);
  }
  for (const folder of contents.directories) {
    await mkdir(await safePath(root, destination + folder.slice(rel.length)), { recursive: true });
  }
  for (const folder of [...contents.directories].reverse()) {
    await rmdir(await safePath(root, folder));
  }
}
function directoryOrFile(input: unknown) {
  if (input === 'src' || input === 'public') {
    return input;
  }
  return filePath(input);
}
function child(parent: string, input: unknown) {
  const name = string(input, 255).trim();
  if (!name || name.includes('/') || name.includes('\\')) {
    throw new Error('Use a single folder or file name');
  }
  return filePath(parent + '/' + name);
}
async function vacant(root: string, file: string) {
  try {
    await access(await safePath(root, file));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error('An asset or folder with that name already exists');
}

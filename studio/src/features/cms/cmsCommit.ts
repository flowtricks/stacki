import { CMS_DELETED } from './cmsDeleted';
import { rm } from 'node:fs/promises';
import { checksum, type createRooms } from '../collaboration/rooms';
import { changeFiles } from '../project/changeFiles';
import { safePath } from '../project/projectServer';
import { sourcePath, string } from '../../shared/validation';

export async function commitCms(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  versions: Readonly<Record<string, unknown>>,
) {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
  if (changed.length > 50) {
    throw new Error('Change at most 50 CMS files at once');
  }
  for (const file of changed) {
    sourcePath(file);
    string(after.get(file) ?? '');
    const original = before.get(file);
    if (file !== CMS_DELETED && original !== undefined && versions[file] !== checksum(original)) {
      throw new Error(`${file} changed. Refresh the collection before saving.`);
    }
  }
  try {
    await changeFiles(
      root,
      rooms,
      changed.flatMap((file) => {
        const source = after.get(file);
        return source === undefined ? [] : [{ file, source }];
      }),
    );
    for (const file of changed.filter((file) => !after.has(file))) {
      await rooms.remove(file);
      await rm(await safePath(root, file));
    }
  } catch (error) {
    // A rename or deletion is one batch: restore all affected sources on failure.
    await changeFiles(
      root,
      rooms,
      changed.flatMap((file) => {
        const source = before.get(file);
        return source === undefined ? [] : [{ file, source }];
      }),
    );
    for (const file of changed.filter((file) => !before.has(file))) {
      await rooms.remove(file);
      await rm(await safePath(root, file), { force: true });
    }
    throw error;
  }
}
export function cmsVersions(sources: ReadonlyMap<string, string>) {
  return Object.fromEntries([...sources].map(([file, source]) => [file, checksum(source)]));
}

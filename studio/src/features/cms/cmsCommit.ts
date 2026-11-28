import { CMS_DELETED } from './cmsDeleted';
import { rm } from 'node:fs/promises';
import { checksum, type createRooms } from '../collaboration/rooms';
import { changeFiles } from '../project/changeFiles';
import { safePath } from '../project/projectServer';
import { sourcePath, string } from '../../shared/validation';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { writesCode } from '../roles/codeGuard';
import { assertRoleWrite } from '../roles/writeRules';

export async function commitCms(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  versions: Readonly<Record<string, unknown>>,
  role: RoleView,
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
  await assertCmsWrites(rooms, role, changed, before, after);
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
// Every file is judged before any is written. An entry that moves keeps its code, so what the batch removes or
// replaces is remembered first.
async function assertCmsWrites(
  rooms: ReturnType<typeof createRooms>,
  role: RoleView,
  changed: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) {
  if (writesCode(role)) {
    return;
  }
  for (const file of changed) {
    const original = before.get(file);
    if (original !== undefined) {
      await rooms.guard.retain(file, original);
    }
  }
  for (const file of changed) {
    const source = after.get(file);
    if (source !== undefined) {
      await assertRoleWrite(role, { file, before: before.get(file), after: source }, rooms.guard);
    }
  }
}
export function cmsVersions(sources: ReadonlyMap<string, string>) {
  return Object.fromEntries([...sources].map(([file, source]) => [file, checksum(source)]));
}

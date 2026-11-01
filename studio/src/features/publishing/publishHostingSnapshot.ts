import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath, symlink, constants } from 'node:fs/promises';
import path from 'node:path';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import { publishInventory, publishDisk } from './publishInventory';
import { publishFailure } from './publishFailure';
import { STUDIO_PUBLISH_LIMITS as limits } from './publishLimits';

/** Copy sequentially; reflinks save disk where available without sharing mutable file contents. */
export async function createHostingSnapshot(root: string, destination: string): Promise<Result<void>> {
  assert(root !== destination, 'Hosting uses an isolated directory');
  assert(path.isAbsolute(destination), 'Hosting destination is absolute');
  const inventory = await publishInventory(root, ['.'], limits.hostingBytesMax);
  if (!inventory.ok) {
    return inventory;
  }
  const prepared = await mkdir(destination, { recursive: true, mode: 0o700 }).then(ok, publishFailure);
  if (!prepared.ok) {
    return prepared;
  }
  // Allow a full copy plus equally large output; never rely on reflink availability for capacity.
  const disk = await publishDisk(destination, inventory.value.bytes * 2);
  if (!disk.ok) {
    return disk;
  }
  const deadline = Date.now() + limits.commandTimeoutMs;
  for (const file of inventory.value.files) {
    if (Date.now() > deadline) {
      return err({ code: 'timeout', message: 'Hosting copy exceeded ten minutes.' });
    }
    const target = path.join(destination, file);
    const directory = await mkdir(path.dirname(target), { recursive: true }).then(ok, publishFailure);
    if (!directory.ok) {
      return directory;
    }
    const copied = await copyFile(path.join(root, file), target, constants.COPYFILE_FICLONE).then(ok, publishFailure);
    if (!copied.ok) {
      return copied;
    }
  }
  const dependencies = await realpath(path.join(root, 'node_modules')).then(ok, publishFailure);
  if (!dependencies.ok) {
    return dependencies;
  }
  return symlink(dependencies.value, path.join(destination, 'node_modules'), 'dir').then(() => ok(undefined), publishFailure);
}

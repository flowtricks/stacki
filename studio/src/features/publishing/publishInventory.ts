import assert from 'node:assert/strict';
import { isStudioLocalPath } from '../../../vendor/stacki/shared/properties/studioLocal';
import { opendir, lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import { STUDIO_PUBLISH_LIMITS as limits } from './publishLimits';
import { publishFailure } from './publishFailure';

export interface PublishInventory {
  readonly files: readonly string[];
  readonly bytes: number;
}

/** Directory handles and file metadata are consumed sequentially; no project bytes enter JS. */
export async function publishInventory(
  root: string,
  starts: readonly string[],
  bytesMax: number,
): Promise<Result<PublishInventory>> {
  assert(bytesMax > 0, 'Publish byte budget is positive');
  assert(starts.length <= limits.directoriesMax, 'Inventory roots are bounded');
  const deadline = Date.now() + limits.commandTimeoutMs;
  const pending = [...starts];
  const files: string[] = [];
  let bytes = 0;
  let directories = 0;
  for (let index = 0; index < pending.length; index++) {
    if (Date.now() > deadline) {
      return err({ code: 'timeout', message: 'Publish inspection exceeded ten minutes.' });
    }
    const relative = pending[index];
    assert(relative !== undefined, 'Inventory cursor exists');
    const info = await lstat(path.join(root, relative)).then(ok, publishFailure);
    if (!info.ok) {
      return info;
    }
    if (info.value.isSymbolicLink()) {
      return err({ code: 'link', message: 'Publish cannot include symbolic links: ' + relative });
    }
    if (info.value.isDirectory()) {
      if (++directories > limits.directoriesMax) {
        return err({ code: 'directories', message: 'Publish exceeds 10,000 directories.' });
      }
      const entries = await inventoryDirectory(root, relative, deadline).then(ok, publishFailure);
      if (!entries.ok) {
        return entries;
      }
      for (const entry of entries.value) {
        pending.push(entry);
      }
      if (pending.length > limits.filesMax + limits.directoriesMax) {
        return err({ code: 'files', message: 'Publish exceeds the file/directory budget.' });
      }
    } else if (info.value.isFile()) {
      bytes += info.value.size;
      files.push(relative);
      if (
        files.length > limits.filesMax ||
        info.value.size > limits.fileBytesMax ||
        bytes > bytesMax
      ) {
        return err({
          code: 'size',
          message: 'Publish exceeds its source, file count or 100 MiB file limit.',
        });
      }
    } else {
      return err({ code: 'file', message: 'Publish requires regular files: ' + relative });
    }
  }
  return ok({ files, bytes });
}

async function inventoryDirectory(
  root: string,
  relative: string,
  deadline: number,
): Promise<readonly string[]> {
  const directory = await opendir(path.join(root, relative));
  const files: string[] = [];
  let visited = 0;
  for await (const entry of directory) {
    if (Date.now() > deadline) {
      throw new Error('Publish inspection exceeded ten minutes.');
    }
    if (++visited > limits.filesMax + limits.directoriesMax) {
      throw new Error('Publish directory exceeds its entry limit.');
    }
    const name = relative === '.' ? entry.name : relative + '/' + entry.name;
    if (name.split('/').length > limits.depthMax) {
      throw new Error('Publish path is too deep.');
    }
    if (excluded(name)) {
      continue;
    }
    if (/^(src|public)\//.test(name) && entry.name.startsWith('.')) {
      continue;
    }
    if (name.length > 500 || /[\x00-\x1f\\]/.test(name)) {
      throw new Error('Unsupported publish filename.');
    }
    files.push(name);
  }
  return files;
}

function excluded(file: string): boolean {
  return (
    file
      .split('/')
      .some((part) => ['.git', 'node_modules', '.astro', 'dist', '.studio'].includes(part)) ||
    isStudioLocalPath(file) ||
    ['.stacki/preview', '.stacki/canvas'].includes(file) ||
    /^astro\.studio\.config\.[cm]?[jt]s$/.test(file)
  );
}

export async function publishDisk(root: string, requiredBytes: number): Promise<Result<void>> {
  assert(Number.isSafeInteger(requiredBytes), 'Disk requirement is an integer');
  assert(requiredBytes >= 0, 'Disk requirement is nonnegative');
  const space = await statfs(root).then(ok, publishFailure);
  if (!space.ok) {
    return space;
  }
  return space.value.bavail * space.value.bsize >= requiredBytes + limits.diskReserveBytes
    ? ok(undefined)
    : err({
        code: 'disk',
        message: 'Not enough disk space for publishing. Use a larger Studio container and retry.',
      });
}

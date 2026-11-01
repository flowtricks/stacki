import { ensureToolPath } from '../lib/nodeTools';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { PUBLISH_LIMITS } from '../../shared/properties/publishConfig';
import { readPublishRecords } from './publishRecords';
import { publishFilesystemFailure } from './publishGitCommand';

export type PublishPurpose = 'github' | 'hosting';

// Git can hash a larger source without duplicating it. These are inspection, not checkout, budgets.
export const PUBLISH_GIT_LIMITS = { filesMax: 100_000, bytesMax: 8 * 1024 * 1024 * 1024 } as const;

export async function checkPublishWorkingSize(root: string, index: string, purpose: PublishPurpose): Promise<Result<void>> {
  ensureToolPath();
  let files = 0;
  let bytes = 0;
  return readPublishRecords(
    root,
    ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
    { ...process.env, GIT_INDEX_FILE: index },
    async (file) => {
      const parsed = parsePublishPath(file);
      if (!parsed.ok) {
        return parsed;
      }
      const stats = await lstat(path.join(root, file)).then(ok, (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return ok(undefined);
        }
        return publishFilesystemFailure(error);
      });
      if (!stats.ok) {
        return stats;
      }
      // Deleted tracked paths still appear in the old index but will not enter the new tree.
      if (stats.value === undefined) {
        return ok(undefined);
      }
      files += 1;
      bytes += stats.value.size;
      return checkPublishSize(files, bytes, purpose);
    },
  );
}

/** Measure the captured blobs: working-file sizes can change and clean filters can expand them. */
export async function checkPublishTreeSize(root: string, tree: string, purpose: PublishPurpose): Promise<Result<void>> {
  ensureToolPath();
  let files = 0;
  let bytes = 0;
  return readPublishRecords(root, ['ls-tree', '-r', '-l', '-z', tree], process.env, (record) => {
    const entry = parsePublishTreeEntry(record);
    if (!entry.ok) {
      return Promise.resolve(entry);
    }
    files += 1;
    bytes += entry.value;
    return Promise.resolve(checkPublishSize(files, bytes, purpose));
  });
}

export function parsePublishTreeEntry(record: string): Result<number> {
  const match = /^(?:100644|100755|120000) blob (?:[a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t([\s\S]+)$/.exec(record);
  if (match?.[1] === undefined || match[2] === undefined) {
    return err({ code: 'git-output', message: 'Unsupported or malformed Git tree entry.' });
  }
  const file = parsePublishPath(match[2]);
  if (!file.ok) {
    return file;
  }
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size < 0) {
    return err({ code: 'git-output', message: 'Git returned an invalid file size.' });
  }
  return ok(size);
}

function parsePublishPath(file: string): Result<string> {
  if (path.isAbsolute(file) || file.split('/').some((part) => part === '..' || part === '')) {
    return err({ code: 'git-output', message: 'Git returned a path outside the project.' });
  }
  return ok(file);
}

function checkPublishSize(files: number, bytes: number, purpose: PublishPurpose): Result<void> {
  if (purpose === 'hosting') {
    if (files > PUBLISH_LIMITS.filesMax) {
      return err({
        code: 'snapshot-limit',
        message: 'Publish exceeds the 10,000-file snapshot limit.',
      });
    }
    if (bytes > PUBLISH_LIMITS.snapshotBytesMax) {
      return err({
        code: 'snapshot-limit',
        message: 'Publish exceeds the 256 MiB snapshot limit.',
      });
    }
  } else {
    if (files > PUBLISH_GIT_LIMITS.filesMax) {
      return err({ code: 'git-limit', message: 'Git inspection exceeds the 100,000-file limit.' });
    }
    if (bytes > PUBLISH_GIT_LIMITS.bytesMax) {
      return err({ code: 'git-limit', message: 'Git inspection exceeds the 8 GiB source limit.' });
    }
  }
  return ok(undefined);
}

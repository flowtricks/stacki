// The renderer's face of `apps:fileStamps` (electron/handlers/appPageFilesHandlers.ts):
// modification stamps for the pages and components a Stacki app reads, parsed
// before the page index (src/features/apps/appPageIndex.ts) trusts them.
import { assert } from '../../shared/core/assert';
import { record } from '../../shared/core/boundary';
import { toArray } from '../../shared/core/record';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';

export interface FileStamp {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** Each file's stamp, in the order asked; undefined for a file that is gone. */
export async function appFileStamps(projectPath: string, rels: readonly string[]): Promise<readonly (FileStamp | undefined)[]> {
  const input = parseIpcPayload('apps:fileStamps', { projectPath, rels: [...rels] });
  const stamps = parseFileStamps(await window.avb.appFileStamps(input), rels.length);
  assert(stamps.length === rels.length, 'Every file asked about has an answer');
  return stamps;
}

/** The reply: one stamp or undefined per file asked about. */
export function parseFileStamps(input: unknown, expected: number): readonly (FileStamp | undefined)[] {
  const items = toArray(record(input)['stamps']);
  if (items === undefined || items.length !== expected) {
    throw new Error('apps:fileStamps: expected one stamp per file');
  }
  return items.map((item) => {
    if (item === undefined) {
      return undefined;
    }
    const stamp = record(item);
    const mtimeMs = stamp['mtimeMs'];
    const sizeBytes = stamp['sizeBytes'];
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) {
      throw new Error('apps:fileStamps: expected a modification time');
    }
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error('apps:fileStamps: expected a size in bytes');
    }
    return { mtimeMs, sizeBytes };
  });
}

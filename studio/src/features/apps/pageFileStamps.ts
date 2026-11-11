// Studio's server side of the stamps a Stacki app's page index keys its cache by
// (vendor/stacki/src/features/apps/appPageIndex.ts): `/studio/api/file-stamps`,
// Desktop's `apps:fileStamps` over HTTP. One batch is at most
// APP_FILE_STAMPS_MAX source files, each confined to the project; a file that is
// gone answers undefined (null on the wire, as JSON writes it) rather than failing the batch.
import { stat } from 'node:fs/promises';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { APP_FILE_STAMPS_MAX } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import { safePath } from '../project/projectServer';
import { record, sourcePath } from '../../shared/validation';

export interface FileStampReply {
  // A file that is gone is undefined; JSON.stringify writes it as null, which the client reads back as undefined.
  readonly stamps: readonly ({ readonly mtimeMs: number; readonly sizeBytes: number } | undefined)[];
}

/** The files a stamp request names: Studio source paths, at most APP_FILE_STAMPS_MAX. */
export function parseFileStampRequest(input: unknown): readonly string[] {
  const files = record(input)['files'];
  if (!Array.isArray(files)) {
    throw new Error('files must be a list');
  }
  if (files.length > APP_FILE_STAMPS_MAX) {
    throw new Error(`An app stamps at most ${APP_FILE_STAMPS_MAX} files at once`);
  }
  return files.map((file: unknown) => sourcePath(file));
}

export async function fileStamps(root: string, files: readonly string[]): Promise<FileStampReply> {
  assert(files.length <= APP_FILE_STAMPS_MAX, 'A stamp batch is bounded by its parser');
  const stamps = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(await safePath(root, file));
        return info.isFile() ? { mtimeMs: info.mtimeMs, sizeBytes: info.size } : undefined;
      } catch {
        return undefined; // Gone between the scan and the stamp: the index forgets it.
      }
    }),
  );
  assert(stamps.length === files.length, 'Every file asked about is answered');
  return { stamps };
}

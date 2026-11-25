// Studio's reads for a Stacki app's page index (vendor/stacki/src/features/apps/appPageIndex.ts):
// each file's modification stamp from `/studio/api/file-stamps` (pageFileStamps.ts),
// and a file's source from `/studio/api/file`, parsed here with the parser the
// editor opens pages with, so ids match what opening the file would give.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { request } from '../project/projectClient';
import { parsePage, type ParserNode } from '../source/source';
import { record, string } from '../../shared/validation';

export interface StudioFileStamp {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** Each file's stamp, in the order asked; undefined for a file that is gone. */
export async function studioFileStamps(files: readonly string[]): Promise<readonly (StudioFileStamp | undefined)[]> {
  const reply = record(
    await request('/studio/api/file-stamps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) }),
  );
  const stamps = reply['stamps'];
  if (!Array.isArray(stamps) || stamps.length !== files.length) {
    throw new Error('file-stamps: expected one stamp per file');
  }
  return stamps.map((stamp: unknown) => {
    if (stamp === null || stamp === undefined) {
      return undefined;
    }
    const value = record(stamp);
    const mtimeMs = value['mtimeMs'];
    const sizeBytes = value['sizeBytes'];
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) {
      throw new Error('file-stamps: expected a modification time');
    }
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error('file-stamps: expected a size in bytes');
    }
    return { mtimeMs, sizeBytes };
  });
}

/** A file's tree as opening it would give it; undefined nodes when it cannot be edited as a tree. */
export async function studioFileTree(file: string): Promise<{ readonly editable: boolean; readonly nodes: readonly ParserNode[] }> {
  const source = string(record(await request(`/studio/api/file?file=${encodeURIComponent(file)}`))['source']);
  const parsed = parsePage(source, { locs: true });
  assert(typeof parsed.editable === 'boolean', 'A parse says whether the page is editable');
  return parsed.editable ? { editable: true, nodes: parsed.model.nodes } : { editable: false, nodes: [] };
}

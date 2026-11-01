import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { MAX_SOURCE } from '../../shared/validation';

export type MergeResult = { readonly kind: 'merged'; readonly source: string } | { readonly kind: 'conflict' };
export async function mergeSource(base: string, local: string, remote: string, preferDraft = false): Promise<MergeResult> {
  if ([base, local, remote].some((source) => source.length > MAX_SOURCE)) {
    throw new Error('Merge input exceeds source limit');
  }
  if (local === base || local === remote) {
    return { kind: 'merged', source: remote };
  }
  if (remote === base) {
    return { kind: 'merged', source: local };
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-merge-'));
  const localFile = path.join(directory, 'local');
  try {
    await Promise.all([writeFile(localFile, local), writeFile(path.join(directory, 'base'), base), writeFile(path.join(directory, 'remote'), remote)]);
    try {
      await promisify(execFile)(
        'git',
        ['merge-file', ...(preferDraft ? ['--ours'] : []), '--', localFile, path.join(directory, 'base'), path.join(directory, 'remote')],
        { timeout: 10_000, maxBuffer: MAX_SOURCE },
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'number' && error.code > 0 && error.code < 128) {
        return { kind: 'conflict' };
      }
      throw error;
    }
    return { kind: 'merged', source: await readFile(localFile, 'utf8') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

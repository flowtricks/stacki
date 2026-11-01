import { parsePublishedStatusFiles } from '../publishing/publishStatusRemote';
import { gitRevision } from './gitWorkspaceContract';
import type { GitWorkspaceRun } from './gitWorkspaceObjects';

// Asking ls-tree for blob sizes hydrates missing blobs in a partial clone. Status
// only needs paths, modes and hashes, so it must never request file contents.
export async function gitWorkspaceTree(run: GitWorkspaceRun, tree: string) {
  const output = await run(['ls-tree', '-r', '-z', gitRevision(tree)]);
  const records = output.split('\0').filter(Boolean);
  if (records.length > 20_000) {
    throw new Error('Git workspace tree exceeds its file limit.');
  }
  const entries = records.map((entry) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) {
      throw new Error('Invalid Git workspace tree entry.');
    }
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
  const parsed = parsePublishedStatusFiles({ truncated: false, tree: entries });
  return [...parsed].flatMap(([file, entry]) => (entry.mode === '100644' || entry.mode === '100755' ? [{ path: file, ...entry }] : []));
}

import { record, string } from '../../shared/validation';
import { independentlyDeployed } from './syncPaths';
interface TreeEntry {
  readonly sha: string;
  readonly mode: string;
  readonly type: string;
}
// GitHub's compare endpoint silently caps its file list at 300. Comparing
// complete trees avoids dropping site changes behind a large Studio update.
export function treeChanges(before: unknown, after: unknown) {
  const previous = treeFiles(before);
  const next = treeFiles(after);
  const paths = new Set([...previous.keys(), ...next.keys()]);
  return [...paths].sort().flatMap((filename) => {
    const a = previous.get(filename);
    const b = next.get(filename);
    if (a?.sha === b?.sha && a?.mode === b?.mode) {
      return [];
    }
    if ((a && a.type !== 'blob') || (b && b.type !== 'blob') || a?.mode === '120000' || b?.mode === '120000') {
      throw new Error(`GitHub changed a link or submodule at ${filename}. Update the runtime before syncing.`);
    }
    return [{ filename, status: !a ? 'added' : !b ? 'removed' : 'modified' }];
  });
}
export function treeFiles(input: unknown): Map<string, TreeEntry> {
  const data = record(input);
  const tree = data['tree'];
  if (data['truncated'] !== false || !Array.isArray(tree) || tree.length > 100_000) {
    throw new Error('GitHub returned an incomplete repository tree; sync cannot safely skip unseen files.');
  }
  const files = new Map<string, TreeEntry>();
  for (const input of tree) {
    const entry = record(input);
    const path = string(entry['path'], 500);
    if (entry['type'] === 'tree' || independentlyDeployed(path)) {
      continue;
    }
    const sha = string(entry['sha'], 64);
    if (!/^[a-f0-9]{40,64}$/.test(sha) || files.has(path)) {
      throw new Error('Invalid repository tree');
    }
    files.set(path, { sha, mode: string(entry['mode'], 10), type: string(entry['type'], 10) });
  }
  return files;
}

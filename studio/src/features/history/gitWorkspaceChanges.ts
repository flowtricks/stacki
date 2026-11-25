import assert from 'node:assert/strict';
import { gitWorkspaceTree } from './gitWorkspaceTree';
import type { PublishGit } from '../publishing/publishGit';
import { describeFiles } from '../../../vendor/stacki/electron/git/gitHistory';
import { gitRevision } from './gitWorkspaceContract';
import { gitWorkspaceFile, gitWorkspaceRun, type GitWorkspaceRun } from './gitWorkspaceObjects';
import { ReferencedError } from '../../shared/referencedError';

export async function gitWorkspaceChanges(run: GitWorkspaceRun, head: string, tree: string) {
  const output = await run(['diff', '--name-status', '--no-renames', '-z', head, tree]);
  const fields = output.split('\0');
  const files: { readonly status: string; readonly path: string }[] = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (!status || !file || !gitWorkspaceFile(file)) {
      throw new Error('Git returned an invalid changed file.');
    }
    files.push({ status, path: file });
  }
  assert(files.length <= 100_000, 'Git change counts are bounded');
  return describeFiles(files).map((file) => ({
    ...file,
    staged: false,
    untracked: file.status === 'A',
  }));
}
export async function gitSelectedTree(git: PublishGit, head: string, draft: string, selection: readonly string[]): Promise<string> {
  if (selection.length === 0 || selection.length > 100_000) {
    throw new ReferencedError('git.studio.selectFile');
  }
  const run = gitWorkspaceRun(git);
  const changes = await gitWorkspaceChanges(run, head, draft);
  const changed = new Set(changes.map((file) => file.path));
  const files = new Map((await gitWorkspaceTree(run, draft)).map((file) => [file.path, file]));
  const entries = selection.map((file) => {
    if (!changed.has(file)) {
      throw new ReferencedError('git.studio.fileChanged');
    }
    const entry = files.get(file);
    return entry ? `${entry.mode} ${entry.sha}\t${file}\0` : `0 ${'0'.repeat(40)}\t${file}\0`;
  });
  await run(['read-tree', head]);
  await run(['update-index', '-z', '--index-info'], entries.join(''));
  // Inherited entries already came from a validated Git tree. Requiring their blobs
  // here would download unchanged files just to report status or stage a selection.
  return gitRevision(await run(['write-tree', '--missing-ok']));
}

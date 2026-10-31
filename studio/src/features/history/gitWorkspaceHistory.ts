import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { readGitWorkspace } from './gitWorkspaceStorage';
import { gitWorkspaceBranch, type GitWorkspaceManifest } from './gitWorkspaceContract';
import { gitWorkspaceRun } from './gitWorkspaceObjects';
import type { PublishGit } from '../publishing/publishGit';

/** A separate reference view keeps parked drafts and in-flight merges out of the graph. */
export async function gitWorkspaceHistory(root: string, token: string) {
  const manifest = await readGitWorkspace(root);
  if (!manifest) {
    return undefined;
  }
  const parent = path.join(root, '.stacki/studio/state');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'history-'));
  const git = { root, directory, authorization: token };
  try {
    await buildHistoryView(git, manifest);
    return {
      directory,
      at: Date.now(),
      depth: 301,
      remoteHeads: manifest.revision,
      info: {
        repository: manifest.repository,
        branch: manifest.branch,
        branches: manifest.branches.map((branch) => branch.name),
        head: gitWorkspaceBranch(manifest).head,
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function buildHistoryView(git: PublishGit, manifest: GitWorkspaceManifest) {
  const run = gitWorkspaceRun(git);
  await run([
    'clone',
    '--bare',
    '--shared',
    '--quiet',
    path.join(git.root, '.stacki/studio/state/workspace.git'),
    git.directory,
  ]);
  const references = (await run(['for-each-ref', '--format=%(refname)']))
    .split('\n')
    .filter(Boolean);
  if (references.length > 194) {
    throw new Error('Git history exceeds its reference limit.');
  }
  for (const reference of references) {
    await run(['update-ref', '-d', reference]);
  }
  for (const branch of manifest.branches) {
    await run(['update-ref', 'refs/heads/' + branch.name, branch.head]);
  }
  await run(['symbolic-ref', 'HEAD', 'refs/heads/' + manifest.branch]);
  await run(['config', 'remote.origin.url', `https://github.com/${manifest.repository}.git`]);
  await run(['config', 'remote.origin.promisor', 'true']);
  await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
}

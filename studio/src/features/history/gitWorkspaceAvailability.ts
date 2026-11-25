import type { PublishConnection } from '../../shared/publishConnection';
import { gitWorkspaceTree } from './gitWorkspaceTree';
import type { PublishStatusSource } from '../publishing/publishStatusSource';
import { gitWorkspaceBranch, type GitWorkspaceManifest } from './gitWorkspaceContract';
import { gitWorkspaceContext, gitWorkspaceRun } from './gitWorkspaceObjects';

export async function gitWorkspaceAvailability(root: string, source: PublishStatusSource, connection: PublishConnection, workspace: GitWorkspaceManifest) {
  const git = gitWorkspaceContext(root, connection);
  const head = gitWorkspaceBranch(workspace).head;
  const files = await gitWorkspaceTree(gitWorkspaceRun(git), head);
  const dirty = await source.differs(new Map(files.map((file) => [file.path, file])));
  const remote = workspace.remote.find((entry) => entry.name === workspace.branch);
  const commits = Number(
    await gitWorkspaceRun(git)(['rev-list', '--count', head, ...(remote ? ['^' + remote.head] : workspace.remote.map((entry) => '^' + entry.head))]),
  );
  if (!Number.isSafeInteger(commits) || commits < 0) {
    throw new Error('Invalid outgoing commit count.');
  }
  return { changed: dirty || commits > 0 || !remote, commits: commits + (dirty ? 1 : 0) };
}

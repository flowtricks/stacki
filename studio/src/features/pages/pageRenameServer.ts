import { projectAliases } from '../../../vendor/stacki/electron/properties/importPaths';
import { studioRenameWriter } from './pageRenameWriter';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parsePageRename } from '../../../vendor/stacki/shared/properties/pageRename';
import { planPageRename, type PageRenamePlan } from '../../../vendor/stacki/electron/project/pageRenamePlan';
import { applyPageRename, undoPageRename } from '../../../vendor/stacki/electron/project/pageRenameWrite';
import type { createRooms } from '../collaboration/rooms';
import { githubFromEnvironment } from '../publishing/publish';
import { GitWorkspace, type GitWorkspaceState } from '../history/gitWorkspace';
import { gitWorkspaceBranch } from '../history/gitWorkspaceContract';
import { checkpointGitWorkspace } from '../history/gitWorkspaceCheckpoint';
import { snapshotGitWorkspace, gitWorkspaceCommit, gitWorkspaceRun } from '../history/gitWorkspaceObjects';
import { gitWorkspaceNeedsRecovery, setGitWorkspaceBusy } from '../history/gitWorkspaceLease';
import { readWorkspaceId } from '../project/projectIdentity';

export async function pageRenameRoute(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/pages/rename' || request.method !== 'POST') {
    return false;
  }
  const input: unknown = JSON.parse(await readBody());
  const change = parsePageRename(input);
  await rooms.coordinator.run(async () => {
    await rooms.persist();
    const planned = planPageRename(root, change, projectAliases(root));
    if (!planned.ok) {
      throw new Error(planned.error.message);
    }
    const state = await renameWorkspace(root);
    const applied = applyPageRename(planned.value, studioRenameWriter);
    if (!applied.ok) {
      throw new Error(applied.error.message);
    }
    await persistPageRename(planned.value, state);
    // Old CRDT identities must never write back to a moved source path.
    await rooms.resetWorkspace();
  });
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('x-studio-workspace', (await readWorkspaceId(root)) ?? '');
  response.end(JSON.stringify({ ok: true }));
  return true;
}
async function renameWorkspace(root: string): Promise<GitWorkspaceState | undefined> {
  if (!process.env['STUDIO_BACKEND_URL']) {
    return undefined;
  }
  const repository = githubFromEnvironment(root);
  if (!repository) {
    throw new Error('Reconnect the project repository before renaming pages.');
  }
  return new GitWorkspace(root, () => repository.historyConnection()).load();
}
export async function persistPageRename(plan: PageRenamePlan, state: GitWorkspaceState | undefined) {
  if (!state) {
    return;
  }
  try {
    const { git, manifest } = state;
    const branch = gitWorkspaceBranch(manifest);
    const tree = await snapshotGitWorkspace(git, branch.head);
    const draft = await gitWorkspaceCommit(gitWorkspaceRun(git), tree, [branch.head], 'Studio page rename draft');
    // One durable checkpoint records deletions AND switches the draft namespace;
    // startup cannot resurrect old paths from stale collaboration snapshots.
    await checkpointGitWorkspace(git, manifest, {
      ...manifest,
      draft,
      branches: manifest.branches.map((entry) => (entry.name === manifest.branch ? { ...entry, workspace: randomUUID() } : entry)),
    });
  } catch (error: unknown) {
    if (gitWorkspaceNeedsRecovery(plan.root)) {
      setGitWorkspaceBusy(plan.root, 'recovery');
    } else {
      const restored = undoPageRename(plan, studioRenameWriter);
      if (!restored.ok) {
        setGitWorkspaceBusy(plan.root, 'recovery');
        throw new Error(restored.error.message);
      }
    }
    throw error;
  }
}

import { readWorkspaceId } from '../project/projectIdentity';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseIpcPayload } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import type { NativeRepository } from '../github/nativeRepository';
import type { createRooms } from '../collaboration/rooms';
import { GitWorkspace, type GitWorkspaceState } from './gitWorkspace';
import {
  gitBranchName,
  gitWorkspaceBranch,
  type GitWorkspaceManifest,
} from './gitWorkspaceContract';
import { checkpointGitWorkspace } from './gitWorkspaceCheckpoint';
import { switchGitWorkspace } from './gitWorkspaceSwitch';
import { mergeGitWorkspace } from './gitWorkspaceMerge';
import {
  pullGitWorkspace,
  parkGitWorkspace,
  unparkGitWorkspace,
  deleteGitWorkspaceBranch,
} from './gitWorkspaceActions';
import { prepareGitWorkspaceCheckout } from './gitWorkspaceCheckout';
import { setGitWorkspaceBusy, gitWorkspaceNeedsRecovery } from './gitWorkspaceLease';
import { emptyAssetState } from '../assets/assetStateTypes';
import { saveAssetState } from '../assets/assetState';
import { record } from '../../shared/validation';

export function gitWorkspaceRoutes(
  root: string,
  repository: Pick<NativeRepository, 'historyConnection'> | undefined,
  rooms: ReturnType<typeof createRooms>,
  publishing: () => boolean,
) {
  const workspace = new GitWorkspace(root, () =>
    repository
      ? repository.historyConnection()
      : Promise.resolve({
          ok: false,
          error: { code: 'repository', message: 'Connect GitHub first.' },
        }),
  );
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    readBody: () => Promise<string>,
  ) => {
    if (!pathname.startsWith('/studio/api/git/')) {
      return false;
    }
    response.setHeader('Content-Type', 'application/json');
    try {
      const command = pathname.slice('/studio/api/git/'.length);
      const input: unknown = request.method === 'POST' ? JSON.parse(await readBody()) : {};
      const data = { ...record(input), projectPath: root };
      if (request.method !== 'POST') {
        throw new Error('Git commands require POST.');
      }
      const value = await workspace.queue.run(async () => {
        if (publishing()) {
          throw new Error('Wait for publishing to finish before changing Git.');
        }
        return rooms.coordinator.run(async () => {
          setGitWorkspaceBusy(root, 'working');
          try {
            await rooms.persist();
            const state = await workspace.load();
            return await runGitWorkspaceCommand(workspace, state, rooms, command, data);
          } finally {
            if (!gitWorkspaceNeedsRecovery(root)) {
              setGitWorkspaceBusy(root, 'idle');
            }
          }
        });
      });
      response.setHeader('x-studio-workspace', (await readWorkspaceId(root)) ?? '');
      response.end(JSON.stringify(value));
    } catch (error: unknown) {
      response.statusCode = 409;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Git failed.' }),
      );
    }
    return true;
  };
}
async function runGitWorkspaceCommand(
  workspace: GitWorkspace,
  state: GitWorkspaceState,
  rooms: ReturnType<typeof createRooms>,
  command: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case 'info':
      return workspace.info(state);
    case 'status':
      return workspace.status(state);
    case 'incoming':
      return workspace.incoming(state);
    case 'commit': {
      const input = parseIpcPayload('git:commit', data);
      return workspace.commit(state, input.message ?? 'Update from Stacki', input.paths);
    }
    case 'checkout':
      return applyGitWorkspaceChange(
        state,
        rooms,
        await switchGitWorkspace(state, parseIpcPayload('git:checkout', data)),
      );
    case 'pull': {
      const pulled = await pullGitWorkspace(state);
      if ('review' in pulled && 'conflicted' in pulled.result) {
        workspace.review = {
          kind: 'pending',
          branch: pulled.result.branch,
          head: gitWorkspaceBranch(state.manifest).head,
          ...pulled.review,
        };
      }
      return applyGitWorkspaceChange(state, rooms, pulled);
    }
    case 'park':
      return applyGitWorkspaceChange(state, rooms, await parkGitWorkspace(state));
    case 'unpark':
      return applyGitWorkspaceChange(state, rooms, await unparkGitWorkspace(state));
    case 'deleteBranch':
      return deleteGitWorkspaceBranch(state, parseIpcPayload('git:deleteBranch', data));
    case 'merge':
    case 'resolveMerge':
      return applyGitWorkspaceChange(
        state,
        rooms,
        await resolveGitWorkspaceCommand(workspace, state, command, data),
      );
    default:
      throw new Error('Unsupported Git command.');
  }
}
async function applyGitWorkspaceChange(
  state: GitWorkspaceState,
  rooms: ReturnType<typeof createRooms>,
  change: {
    readonly result: unknown;
    readonly manifest?: GitWorkspaceManifest;
    readonly target?: string;
  },
) {
  if (!change.manifest || !change.target) {
    return change.result;
  }
  const root = state.git.root;
  setGitWorkspaceBusy(root, 'working');
  let persisted = false;
  const staged = await prepareGitWorkspaceCheckout(
    state.git,
    gitWorkspaceBranch(state.manifest).head,
    change.target,
  );
  try {
    // A new document namespace prevents offline edits on the old checkout from
    // being replayed onto the replacement tree, even when the file names match.
    const manifest = {
      ...change.manifest,
      branches: change.manifest.branches.map((entry) =>
        entry.name === change.manifest?.branch ? { ...entry, workspace: randomUUID() } : entry,
      ),
    };
    const saved = await checkpointGitWorkspace(state.git, state.manifest, manifest);
    persisted = true;
    await staged.apply();
    await rm(path.join(root, '.stacki/studio/state/asset-state.json'), { force: true });
    await saveAssetState(root, emptyAssetState);
    const remote = saved.remote.find((entry) => entry.name === saved.branch);
    await writeFile(
      path.join(root, '.stacki/studio/state/github-base.json'),
      JSON.stringify({ sha: remote?.head ?? gitWorkspaceBranch(saved).head }),
    );
    await rooms.resetWorkspace();
    setGitWorkspaceBusy(root, 'idle');
    return change.result;
  } catch (error) {
    setGitWorkspaceBusy(root, persisted || gitWorkspaceNeedsRecovery(root) ? 'recovery' : 'idle');
    throw error;
  } finally {
    await staged.dispose();
  }
}

async function resolveGitWorkspaceCommand(
  workspace: GitWorkspace,
  state: GitWorkspaceState,
  command: string,
  data: Record<string, unknown>,
) {
  const branch = gitBranchName(data['branch']);
  const review = workspace.review;
  const remoteReview = branch.startsWith('refs/remotes/origin/');
  if (
    remoteReview &&
    (review.kind !== 'pending' ||
      review.branch !== branch ||
      review.head !== gitWorkspaceBranch(state.manifest).head)
  ) {
    throw new Error('The pull review changed. Pull again to review its current conflicts.');
  }
  const target =
    remoteReview && review.kind === 'pending'
      ? review.target
      : state.manifest.branches.find((entry) => entry.name === branch)?.head;
  if (!target) {
    throw new Error('This branch no longer exists.');
  }
  const choices =
    command === 'resolveMerge' ? parseIpcPayload('git:resolveMerge', data).choices : undefined;
  const merged = await mergeGitWorkspace(state, branch, target, choices);
  if (merged.manifest && remoteReview && review.kind === 'pending') {
    return { ...merged, manifest: { ...merged.manifest, remote: review.remote } };
  }
  return merged;
}

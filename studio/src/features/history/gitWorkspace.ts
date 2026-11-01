import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { PublishConnection } from '../../shared/publishConnection';
import type { Result } from '../../../vendor/stacki/shared/core/result';
import type { PublishGit } from '../publishing/publishGit';
import { published } from '../publishing/publishFailure';
import { SerialQueue } from '../../shared/serialQueue';
import { checkpointGitWorkspace } from './gitWorkspaceCheckpoint';
import { gitSelectedTree, gitWorkspaceChanges } from './gitWorkspaceChanges';
import { readGitWorkspace, writeLocalGitWorkspace } from './gitWorkspaceStorage';
import { gitBranchName, gitRevision, gitWorkspaceBranch, type GitWorkspaceManifest } from './gitWorkspaceContract';
import {
  fetchGitWorkspaceHeads,
  gitWorkspaceContext,
  gitWorkspaceRun,
  initializeGitWorkspace,
  readGitWorkspaceBaseline,
  snapshotGitWorkspace,
  gitWorkspaceCommit,
} from './gitWorkspaceObjects';

export interface GitWorkspaceState {
  readonly git: PublishGit;
  readonly manifest: GitWorkspaceManifest;
}
export class GitWorkspace {
  readonly queue = new SerialQueue();
  review:
    | { readonly kind: 'none' }
    | {
        readonly kind: 'pending';
        readonly branch: string;
        readonly head: string;
        readonly target: string;
        readonly remote: GitWorkspaceManifest['remote'];
      } = { kind: 'none' };
  constructor(
    readonly root: string,
    private readonly connection: () => Promise<Result<PublishConnection>>,
  ) {}
  async load(): Promise<GitWorkspaceState> {
    const connection = published(await this.connection());
    const manifest = await readGitWorkspace(this.root);
    if (manifest && manifest.repository !== connection.repository) {
      throw new Error('The repository changed. Recover your existing Git workspace first.');
    }
    const git = gitWorkspaceContext(this.root, connection);
    const exists = await access(path.join(git.directory, 'HEAD')).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await initializeGitWorkspace(git, connection, manifest);
    }
    return { git, manifest: manifest ?? (await this.initialize(git, connection)) };
  }
  async info(state: GitWorkspaceState) {
    const { git, manifest } = state;
    const run = gitWorkspaceRun(git);
    const branch = gitWorkspaceBranch(manifest);
    const tree = await snapshotGitWorkspace(git, branch.head);
    const changed = await gitWorkspaceChanges(run, branch.head, tree);
    const remote = manifest.remote.find((reference) => reference.name === manifest.branch);
    const ahead = Number(await run(['rev-list', '--count', branch.head, ...(remote ? ['^' + remote.head] : manifest.remote.map((entry) => '^' + entry.head))]));
    if (!Number.isSafeInteger(ahead) || ahead < 0) {
      throw new Error('Invalid outgoing commit count.');
    }
    return {
      isRepo: true as const,
      branch: manifest.branch,
      branches: manifest.branches.map((reference) => reference.name),
      remote: `https://github.com/${manifest.repository}.git`,
      head: branch.head,
      dirty: changed.length > 0,
      dirtyFiles: changed.map((file) => file.path),
      ahead,
      parked: manifest.parked.map((reference) => reference.name),
      trunk: manifest.branches.some((reference) => reference.name === 'main') ? 'main' : 'master',
      hasUpstream: remote !== undefined,
    };
  }
  async status(state: GitWorkspaceState) {
    const head = gitWorkspaceBranch(state.manifest).head;
    return gitWorkspaceChanges(gitWorkspaceRun(state.git), head, await snapshotGitWorkspace(state.git, head));
  }
  async commit(state: GitWorkspaceState, message: string, selection?: readonly string[]) {
    const { git, manifest } = state;
    const run = gitWorkspaceRun(git);
    const branch = gitWorkspaceBranch(manifest);
    const draft = await snapshotGitWorkspace(git, branch.head);
    const tree = selection ? await gitSelectedTree(git, branch.head, draft, selection) : draft;
    const changes = await gitWorkspaceChanges(run, branch.head, tree);
    if (!changes.length) {
      throw new Error('There are no changes to commit.');
    }
    const head = await gitWorkspaceCommit(run, tree, [branch.head], message || 'Update from Stacki');
    const snapshot = await gitWorkspaceCommit(run, draft, [head], 'Studio working draft');
    await checkpointGitWorkspace(git, manifest, {
      ...manifest,
      draft: snapshot,
      branches: manifest.branches.map((entry) => (entry.name === branch.name ? { ...entry, head } : entry)),
    });
    return { ok: true as const, files: changes.length };
  }
  async incoming(state: GitWorkspaceState) {
    const run = gitWorkspaceRun(state.git);
    const remote = await fetchGitWorkspaceHeads(run);
    const reference = remote.find((entry) => entry.name === state.manifest.branch);
    if (!reference) {
      return 0;
    }
    const count = Number(await run(['rev-list', '--count', reference.head, '^' + gitWorkspaceBranch(state.manifest).head]));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid incoming commit count.');
    }
    return count;
  }
  private async initialize(git: PublishGit, connection: PublishConnection) {
    const run = gitWorkspaceRun(git);
    const remote = await fetchGitWorkspaceHeads(run);
    const branch = gitBranchName(connection.branch);
    const current = remote.find((reference) => reference.name === branch);
    if (!current) {
      throw new Error('The configured Git branch no longer exists.');
    }
    const head = await readGitWorkspaceBaseline(this.root).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return current.head;
      }
      throw error;
    });
    await run(['fetch', '--quiet', '--depth=301', '--filter=blob:none', '--no-tags', 'origin', head]);
    const manifest: GitWorkspaceManifest = {
      version: 1,
      revision: randomUUID(),
      repository: connection.repository,
      branch,
      branches: remote.map((entry) => ({
        ...entry,
        head: entry.name === branch ? head : entry.head,
        workspace: entry.name === branch ? 'legacy' : randomUUID(),
      })),
      remote,
      parked: [],
      draft: undefined,
      bundle: undefined,
    };
    // The first manifest also preserves the original baseline if GitHub advanced while editing.
    await run(['update-ref', 'refs/heads/' + branch, gitRevision(head)]);
    const saved = await checkpointGitWorkspace(git, undefined, manifest);
    await writeLocalGitWorkspace(this.root, saved);
    return saved;
  }
}

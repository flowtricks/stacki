import { gitWorkspaceHistory } from './gitWorkspaceHistory';
import { readGitWorkspace } from './gitWorkspaceStorage';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { log, describeFiles } from '../../../vendor/stacki/electron/git/gitHistory';
import { readCommitDiff } from '../../../vendor/stacki/electron/git/gitCommitDiff';
import type { CommitDiffRequest } from '../../../vendor/stacki/shared/ipc/gitCommitDiff';
import type { Git } from '../../../vendor/stacki/electron/git/git';
import type { PublishConnection } from '../../shared/publishConnection';
import type { Result } from '../../../vendor/stacki/shared/core/result';
import type { HistoryLog } from '../../../vendor/stacki/src/features/history/historyBridge';
import { publishGit, type PublishGit } from '../publishing/publishGit';
import { SerialQueue } from '../../shared/serialQueue';
import { string } from '../../shared/validation';
import { parseHistoryInfo, type HistoryInfo } from './historyContract';

// History has its own queue and private object store. Fetching Git must never block
// collaborative saves, change the checkout, or retain installation credentials on disk.
export class HistoryRepository {
  private readonly queue = new SerialQueue();
  private readonly logs = new Map<string, HistoryLog & { readonly info: HistoryInfo }>();
  private snapshot:
    | {
        readonly directory: string;
        readonly info: HistoryInfo;
        readonly at: number;
        readonly depth: number;
        readonly remoteHeads: string;
      }
    | undefined;
  constructor(
    private readonly root: string,
    private readonly loadConnection: () => Promise<Result<PublishConnection>>,
    private readonly execute: typeof publishGit = publishGit,
    private readonly now: () => number = Date.now,
  ) {}

  read(skip: number, scope: 'all' | 'current') {
    assert(Number.isSafeInteger(skip), 'History pagination uses safe integers');
    assert(skip >= 0, 'History pagination is bounded');
    assert(skip <= 270, 'History pagination is bounded');
    assert(skip % 30 === 0, 'History pagination uses complete pages');
    return this.queue.run(async () => {
      const snapshot = await this.refresh(skip + 31);
      const key = `${scope}:${skip}`;
      const cached = this.logs.get(key);
      if (cached) {
        return cached;
      }
      const result = await log(this.runner(snapshot.directory), {
        projectPath: this.root,
        limit: 30,
        skip,
        // Rename detection can lazily download blobs from every listed commit.
        // The graph needs only commit/tree metadata; expand a commit for its files.
        withFiles: false,
        ...(scope === 'current' ? { ref: 'refs/heads/' + snapshot.info.branch } : {}),
      });
      const commits = result.commits.map((commit) => ({
        ...commit,
        hash: historyHash(commit.hash),
        shortHash: string(commit.shortHash, 64),
        author: string(commit.author, 1000),
        email: string(commit.email, 1000),
        subject: string(commit.subject, 10_000),
        when: string(commit.when, 100),
        files: undefined,
      }));
      const value = {
        info: snapshot.info,
        commits,
        atEnd: result.atEnd || skip + commits.length >= 300,
      };
      assert(this.logs.size < 20, 'History retains at most ten pages for each of two scopes');
      this.logs.set(key, value);
      return value;
    });
  }

  diff(request: CommitDiffRequest) {
    return this.queue.run(async () => {
      const snapshot = await this.refresh();
      const connection = await this.connection();
      // Only objects reachable from fetched branches may be inspected.
      const git = this.runner(snapshot.directory, connection.token);
      const reachable = await git(this.root, [
        'branch',
        '--contains',
        historyHash(request.commit),
        '--format=%(refname)',
      ]);
      if (!reachable.stdout) {
        throw new Error('This commit is no longer available in the fetched history.');
      }
      return readCommitDiff(git, { ...request, projectPath: this.root });
    });
  }

  commit(hash: string) {
    const commit = historyHash(hash);
    return this.queue.run(async () => {
      const snapshot = await this.refresh();
      const connection = await this.connection();
      const git = this.runner(snapshot.directory, connection.token);
      const reachable = await git(this.root, [
        'branch',
        '--contains',
        commit,
        '--format=%(refname)',
      ]);
      if (!reachable.stdout) {
        throw new Error('This commit is no longer available in the fetched history.');
      }
      const result = await log(git, {
        projectPath: this.root,
        ref: commit,
        limit: 1,
        skip: 0,
        withFiles: true,
      });
      return {
        commits: result.commits.map((entry) => ({
          ...entry,
          files: describeFiles(entry.files),
        })),
        atEnd: true,
      };
    });
  }

  private runner(directory: string, authorization = ''): Git {
    return async (_root, args) => {
      const result = await this.execute({ root: this.root, directory, authorization }, args, '', {
        output: 'verbatim',
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return { stdout: result.value };
    };
  }

  private async connection() {
    const connection = await this.loadConnection();
    if (!connection.ok) {
      throw new Error(connection.error.message);
    }
    return connection.value;
  }

  private async refresh(requestedDepth = 31) {
    const workspace = await readGitWorkspace(this.root);
    if (workspace) {
      if (this.snapshot?.remoteHeads === workspace.revision) {
        return this.snapshot;
      }
      const connection = await this.connection();
      const view = await gitWorkspaceHistory(this.root, connection.token);
      assert(view !== undefined, 'The workspace history exists after reading its manifest');
      if (this.snapshot) {
        await rm(this.snapshot.directory, { recursive: true, force: true });
      }
      this.logs.clear();
      this.snapshot = view;
      return view;
    }
    const depth = Math.max(requestedDepth, this.snapshot?.depth ?? 31);
    if (this.snapshot && this.snapshot.depth >= depth && this.now() - this.snapshot.at < 60_000) {
      return this.snapshot;
    }
    const connection = await this.connection();
    const previous = this.snapshot;
    if (previous && previous.depth >= depth) {
      const remote = `https://github.com/${connection.repository}.git`;
      const heads = await this.execute(
        { root: this.root, directory: previous.directory, authorization: connection.token },
        ['ls-remote', '--heads', remote],
      );
      if (!heads.ok) {
        throw new Error(heads.error.message);
      }
      if (
        previous.info.repository === connection.repository &&
        previous.info.branch === connection.branch &&
        previous.remoteHeads === heads.value
      ) {
        // Poll references rather than rebuilding the object store and recomputing
        // rename diffs every minute while the repository is unchanged.
        this.snapshot = { ...previous, at: this.now() };
        return this.snapshot;
      }
    }
    const parent = path.join(this.root, '.stacki/studio/state');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'history-'));
    const git = { root: this.root, directory, authorization: connection.token };
    try {
      const fetched = await fetchHistory(git, connection, depth, this.execute);
      if (previous) {
        // A failed removal can leave a partial directory; never keep it cached.
        this.snapshot = undefined;
        this.logs.clear();
        await rm(previous.directory, { recursive: true, force: true });
      }
      this.snapshot = { directory, ...fetched, at: this.now(), depth };
      this.logs.clear();
      return this.snapshot;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

async function fetchHistory(
  git: PublishGit,
  connection: { readonly repository: string; readonly branch: string },
  depth: number,
  execute: typeof publishGit,
): Promise<{ readonly info: HistoryInfo; readonly remoteHeads: string }> {
  assert(depth >= 31, 'Git fetch depth includes a page and its parent');
  assert(depth <= 301, 'Git fetch depth stays inside the history bound');
  const run = async (args: readonly string[]) => {
    const result = await execute(git, args);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };
  await run(['init', '--bare', '--quiet', git.directory]);
  const remote = `https://github.com/${connection.repository}.git`;
  const remoteHeads = await run(['ls-remote', '--heads', remote]);
  const heads = remoteHeads.split('\n').filter(Boolean);
  if (heads.length > 64) {
    throw new Error('This repository exceeds the 64-branch history limit.');
  }
  const branches = heads.map((entry) => {
    const [hash, reference] = entry.split('\t');
    historyHash(hash);
    const name = string(reference, 500);
    assert(name.startsWith('refs/heads/'), 'Git heads use branch references');
    return name.slice('refs/heads/'.length);
  });
  if (!branches.includes(connection.branch)) {
    throw new Error('The configured branch is no longer available.');
  }
  await run(['config', 'remote.origin.url', remote]);
  await run(['config', 'remote.origin.promisor', 'true']);
  await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  await run([
    'fetch',
    '--quiet',
    `--depth=${depth}`,
    '--filter=blob:none',
    '--no-tags',
    'origin',
    ...branches.map((branch) => `+refs/heads/${branch}:refs/heads/${branch}`),
  ]);
  const info = parseHistoryInfo({
    repository: connection.repository,
    branch: connection.branch,
    branches,
    head: await run(['rev-parse', 'refs/heads/' + connection.branch]),
  });
  return { info, remoteHeads };
}

export function historyHash(input: unknown): string {
  const value = string(input, 64);
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('Invalid history commit.');
  }
  return value;
}

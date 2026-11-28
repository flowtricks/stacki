import { execFile } from 'node:child_process';
import { isStudioLocalPath } from '../../../vendor/stacki/shared/properties/studioLocal';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { mergeBranch, resolveMerge } from '../../../vendor/stacki/electron/git/gitBranches';
import type { Git } from '../../../vendor/stacki/electron/git/git';
import { published } from '../publishing/publishFailure';
import { publishTreeFiles } from '../publishing/publishSource';
import { publishGit, publishGitEnvironment, type PublishGit } from '../publishing/publishGit';
import { gitRevision, gitWorkspaceBranch } from './gitWorkspaceContract';
import type { GitWorkspaceState } from './gitWorkspace';
import { gitWorkspaceRun, snapshotGitWorkspace, gitWorkspaceCommit, hydrateGitTrees, HYDRATE_LIMITS } from './gitWorkspaceObjects';
import { gitWorkspaceChanges } from './gitWorkspaceChanges';
import { replaceGitWorkspaceReferences } from './gitWorkspaceCheckpoint';

const execute = promisify(execFile);
// Two histories rarely have more than one common ancestor; hydration takes the draft and target beside these.
const MERGE_BASES_MAX = HYDRATE_LIMITS.revisionsMax - 2;
/** Run Desktop's merge engine in an isolated checkout so conflicts never reach the preview. */
export async function mergeGitWorkspace(state: GitWorkspaceState, branch: string, target: string, choices?: Record<string, unknown>) {
  const { git, manifest } = state;
  const current = gitWorkspaceBranch(manifest);
  const run = gitWorkspaceRun(git);
  const draft = await snapshotGitWorkspace(git, current.head);
  const changed = await gitWorkspaceChanges(run, current.head, draft);
  // Keep the exact Desktop conflict UI; dirty overlapping files must be parked first.
  const incoming = new Set((await run(['diff', '--name-only', current.head, target])).split('\n').filter(Boolean));
  const overlapping = changed.filter((file) => incoming.has(file.path));
  if (overlapping.length) {
    return {
      result: {
        ok: false as const,
        dirty: true as const,
        from: manifest.branch,
        branch,
        files: overlapping.map((file) => file.path),
      },
    };
  }
  await hydrateGitTrees(git, [draft, target, ...(await mergeBases(git, current.head, target))]);
  const temporary = await mkdtemp(path.join(git.root, '.stacki/studio/state/merge-'));
  try {
    const context = { ...git, root: temporary };
    await prepareMergeCheckout(context, current.head, draft);
    const runner = mergeWorkspaceRunner(context);
    const result = choices
      ? await resolveMerge(runner, { projectPath: temporary, branch: target, choices })
      : await mergeBranch(runner, { projectPath: temporary, branch: target });
    if (!result.ok) {
      return { result: { ...result, branch } };
    }
    const head = gitRevision(await run(['rev-parse', 'HEAD']));
    const tree = await snapshotGitWorkspace(context, head);
    const snapshot = await gitWorkspaceCommit(run, tree, [head], 'Studio working draft');
    return {
      result,
      manifest: {
        ...manifest,
        draft: snapshot,
        branches: manifest.branches.map((entry) => (entry.name === manifest.branch ? { ...entry, head } : entry)),
      },
      target: snapshot,
    };
  } finally {
    await replaceGitWorkspaceReferences(git, manifest);
    await rm(temporary, { recursive: true, force: true });
  }
}

// A merge reads the common ancestor of any file both sides changed. Unrelated histories have none, and the
// merge itself reports that.
async function mergeBases(git: PublishGit, head: string, target: string): Promise<readonly string[]> {
  const bases = await publishGit(git, ['merge-base', '--all', head, target]);
  return bases.ok ? bases.value.split('\n').filter(Boolean).slice(0, MERGE_BASES_MAX).map(gitRevision) : [];
}

async function prepareMergeCheckout(git: PublishGit, head: string, tree: string) {
  const files = published(await publishTreeFiles(git, tree));
  if (files.some((file) => isStudioLocalPath(file.path))) {
    throw new Error('Repository files cannot overwrite Studio runtime state.');
  }
  const run = gitWorkspaceRun(git);
  await run(['read-tree', tree]);
  await run(['checkout-index', '--stdin', '-z'], files.map((file) => file.path + '\0').join(''));
  await run(['read-tree', head]);
}
function mergeWorkspaceRunner(git: PublishGit): Git {
  return async (_root, args) => {
    if (args.length > 100) {
      throw new Error('Git command exceeds its argument limit.');
    }
    return execute('git', [...args], {
      cwd: git.root,
      env: publishGitEnvironment(git),
      timeout: 600_000,
      maxBuffer: 1024 ** 2,
      encoding: 'utf8',
      shell: false,
    });
  };
}

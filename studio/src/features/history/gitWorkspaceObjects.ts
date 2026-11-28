import { gitWorkspaceTree } from './gitWorkspaceTree';
import { METADATA_FILES } from '../../../vendor/stacki/shared/properties/projectMetadata';
import assert from 'node:assert/strict';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publishGit, type PublishGit } from '../publishing/publishGit';
import { published } from '../publishing/publishFailure';
import { sourceRoots } from '../publishing/publishSource';
import { publishInventory } from '../publishing/publishInventory';
import { gitBranchName, gitRevision, type GitWorkspaceManifest } from './gitWorkspaceContract';
import type { PublishConnection } from '../../shared/publishConnection';
import { downloadGitBundle, copyVerifiedGitBundle } from './gitWorkspaceStorage';

export type GitWorkspaceRun = (args: readonly string[], input?: string) => Promise<string>;
export function gitWorkspaceRun(git: PublishGit): GitWorkspaceRun {
  return async (args, input = '') => published(await publishGit(git, args, input));
}
export function gitWorkspaceContext(root: string, connection: PublishConnection): PublishGit {
  return {
    root,
    directory: path.join(root, '.stacki/studio/state/workspace.git'),
    authorization: connection.token,
  };
}
export async function initializeGitWorkspace(
  git: PublishGit,
  connection: PublishConnection,
  manifest: GitWorkspaceManifest | undefined,
  options: { readonly remote?: string } = {},
): Promise<void> {
  const run = gitWorkspaceRun(git);
  await mkdir(git.directory, { recursive: true, mode: 0o700 });
  await run(['init', '--bare', '--quiet', git.directory]);
  await run(['config', 'remote.origin.url', options.remote ?? `https://github.com/${connection.repository}.git`]);
  await run(['config', 'remote.origin.promisor', 'true']);
  await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  const references = manifest?.remote ?? [];
  for (const reference of references) {
    await run(['fetch', '--quiet', '--depth=301', '--filter=blob:none', '--no-tags', 'origin', reference.head]);
    await run(['update-ref', 'refs/remotes/origin/' + reference.name, reference.head]);
  }
  if (manifest?.bundle) {
    const bundle = path.join(git.directory, 'restore.bundle');
    if (process.env['STUDIO_BACKEND_URL']) {
      await downloadGitBundle(manifest.bundle, bundle);
    } else {
      await copyVerifiedGitBundle(path.join(git.root, '.stacki/studio/state/' + manifest.bundle + '.bundle'), bundle, manifest.bundle);
    }
    await run(['bundle', 'verify', bundle]);
    await run(['fetch', '--quiet', bundle, '+refs/*:refs/*']);
    await rm(bundle);
  }
  if (manifest) {
    for (const branch of manifest.branches) {
      await run(['update-ref', 'refs/heads/' + branch.name, branch.head]);
    }
    await run(['symbolic-ref', 'HEAD', 'refs/heads/' + manifest.branch]);
  }
}
export async function fetchGitWorkspaceHeads(run: GitWorkspaceRun) {
  const lines = (await run(['ls-remote', '--heads', 'origin'])).split('\n').filter(Boolean);
  if (lines.length > 64) {
    throw new Error('Studio supports at most 64 Git branches.');
  }
  const references = lines.map((line) => {
    const [head, reference] = line.split('\t');
    if (!reference?.startsWith('refs/heads/')) {
      throw new Error('Invalid remote Git branch.');
    }
    return { name: gitBranchName(reference.slice(11)), head: gitRevision(head) };
  });
  if (references.length) {
    await run([
      'fetch',
      '--quiet',
      '--depth=301',
      '--filter=blob:none',
      '--no-tags',
      'origin',
      ...references.map((reference) => `+refs/heads/${reference.name}:refs/remotes/origin/${reference.name}`),
    ]);
  }
  return references;
}
export const HYDRATE_LIMITS = {
  // A draft, an incoming head and their merge bases.
  revisionsMax: 8,
  // The listing of missing objects has to fit Git's bounded output (42 bytes each, 1 MiB).
  objectsMax: 20_000,
  // Each batch is one request to GitHub: at most ten for the largest workspace.
  batchObjects: 2_000,
} as const;

/**
 * Download, in a few requests, every file content these trees name and the workspace lacks.
 *
 * Why: the workspace is a blobless partial clone. `ls-tree -l` (it reports sizes) and `checkout-index`
 * make Git fetch each missing blob when they reach it, one request and one process per file: ten to
 * twenty minutes for an ordinary site (issue #104). Call this before either reads a tree's contents.
 *
 * How: `rev-list --missing=print` lists absent objects without fetching them. The fetch is the one Git
 * itself runs for a lazy fetch, with many object names on standard input instead of one. It runs as
 * every other workspace command does (publishGit.ts), so credentials stay out of arguments and errors,
 * and no repository hook or inherited configuration applies. A failure stops the action before it
 * changes any file; falling back to one fetch per file would be the hang again.
 */
export async function hydrateGitTrees(git: PublishGit, revisions: readonly string[]): Promise<void> {
  assert(revisions.length > 0, 'Hydration needs a tree');
  assert(revisions.length <= HYDRATE_LIMITS.revisionsMax, 'Hydrated trees are bounded');
  const run = gitWorkspaceRun(git);
  const missing = await missingGitObjects(run, revisions);
  for (let start = 0; start < missing.length; start += HYDRATE_LIMITS.batchObjects) {
    const batch = missing.slice(start, start + HYDRATE_LIMITS.batchObjects);
    await run(
      [
        // Nothing to negotiate: these are named objects, not history.
        '-c',
        'fetch.negotiationAlgorithm=noop',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        '--stdin',
        'origin',
      ],
      batch.map((object) => object + '\n').join(''),
    );
  }
}

async function missingGitObjects(run: GitWorkspaceRun, revisions: readonly string[]): Promise<readonly string[]> {
  // `^{tree}` limits the listing to these snapshots: a commit alone would walk its history.
  const trees = revisions.map((revision) => gitRevision(revision) + '^{tree}');
  const output = await run(['rev-list', '--objects', '--quiet', '--missing=print', ...trees]);
  const lines = output.split('\n').filter(Boolean);
  if (lines.length > HYDRATE_LIMITS.objectsMax) {
    throw new Error('Git workspace tree exceeds its file limit.');
  }
  return lines.map((line) => {
    assert(line.startsWith('?'), 'A quiet listing prints only missing objects');
    return gitRevision(line.slice(1));
  });
}

/** Only editor-managed files enter the snapshot; installed Studio and runtime state stay out. */
export async function snapshotGitWorkspace(git: PublishGit, head: string): Promise<string> {
  const run = gitWorkspaceRun(git);
  const inventory = published(await publishInventory(git.root, await sourceRoots(git.root), 8 * 1024 ** 3));
  const files = await gitWorkspaceTree(run, head);
  await run(['read-tree', head]);
  const removed = files.filter((file) => gitWorkspaceFile(file.path));
  await run(['update-index', '-z', '--index-info'], removed.map((file) => `0 ${'0'.repeat(40)}\t${file.path}\0`).join(''));
  const list = path.join(git.directory, 'snapshot-paths');
  await writeFile(list, inventory.files.map((file) => file + '\0').join(''));
  if (inventory.files.length) {
    await run(['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=' + list, '--pathspec-file-nul']);
  }
  // Inherited entries already came from a validated Git tree. Requiring their blobs
  // here would download unchanged files just to report status or stage a selection.
  return gitRevision(await run(['write-tree', '--missing-ok']));
}
export function gitWorkspaceFile(file: string): boolean {
  return /^(src|public)\//.test(file) || Object.values(METADATA_FILES).some((name) => name === file);
}
export async function gitWorkspaceCommit(run: GitWorkspaceRun, tree: string, parents: readonly string[], message: string): Promise<string> {
  assert(parents.length <= 2, 'Workspace commits have at most two parents');
  assert(message.length <= 10_000, 'Commit messages are bounded');
  return gitRevision(await run(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', gitRevision(parent)]), '-m', message]));
}
export async function readGitWorkspaceBaseline(root: string): Promise<string> {
  const handle = await open(path.join(root, '.stacki/studio/state/github-base.json'), 'r');
  try {
    if ((await handle.stat()).size > 1024) {
      throw new Error('Git workspace baseline exceeds its limit.');
    }
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (typeof value !== 'object' || value === null || !('sha' in value)) {
      throw new Error('Missing Git workspace baseline.');
    }
    return gitRevision(value.sha);
  } finally {
    await handle.close();
  }
}

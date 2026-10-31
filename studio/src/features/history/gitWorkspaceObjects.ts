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
  await run([
    'config',
    'remote.origin.url',
    options.remote ?? `https://github.com/${connection.repository}.git`,
  ]);
  await run(['config', 'remote.origin.promisor', 'true']);
  await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  const references = manifest?.remote ?? [];
  for (const reference of references) {
    await run([
      'fetch',
      '--quiet',
      '--depth=301',
      '--filter=blob:none',
      '--no-tags',
      'origin',
      reference.head,
    ]);
    await run(['update-ref', 'refs/remotes/origin/' + reference.name, reference.head]);
  }
  if (manifest?.bundle) {
    const bundle = path.join(git.directory, 'restore.bundle');
    if (process.env['STUDIO_BACKEND_URL']) {
      await downloadGitBundle(manifest.bundle, bundle);
    } else {
      await copyVerifiedGitBundle(
        path.join(git.root, '.stacki/studio/state/' + manifest.bundle + '.bundle'),
        bundle,
        manifest.bundle,
      );
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
      ...references.map(
        (reference) => `+refs/heads/${reference.name}:refs/remotes/origin/${reference.name}`,
      ),
    ]);
  }
  return references;
}
/** Only editor-managed files enter the snapshot; installed Studio and runtime state stay out. */
export async function snapshotGitWorkspace(git: PublishGit, head: string): Promise<string> {
  const run = gitWorkspaceRun(git);
  const inventory = published(
    await publishInventory(git.root, await sourceRoots(git.root), 8 * 1024 ** 3),
  );
  const files = await gitWorkspaceTree(run, head);
  await run(['read-tree', head]);
  const removed = files.filter((file) => gitWorkspaceFile(file.path));
  await run(
    ['update-index', '-z', '--index-info'],
    removed.map((file) => `0 ${'0'.repeat(40)}\t${file.path}\0`).join(''),
  );
  const list = path.join(git.directory, 'snapshot-paths');
  await writeFile(list, inventory.files.map((file) => file + '\0').join(''));
  if (inventory.files.length) {
    await run([
      '--literal-pathspecs',
      'add',
      '--force',
      '--pathspec-from-file=' + list,
      '--pathspec-file-nul',
    ]);
  }
  // Inherited entries already came from a validated Git tree. Requiring their blobs
  // here would download unchanged files just to report status or stage a selection.
  return gitRevision(await run(['write-tree', '--missing-ok']));
}
export function gitWorkspaceFile(file: string): boolean {
  return (
    /^(src|public)\//.test(file) || Object.values(METADATA_FILES).some((name) => name === file)
  );
}
export async function gitWorkspaceCommit(
  run: GitWorkspaceRun,
  tree: string,
  parents: readonly string[],
  message: string,
): Promise<string> {
  assert(parents.length <= 2, 'Workspace commits have at most two parents');
  assert(message.length <= 10_000, 'Commit messages are bounded');
  return gitRevision(
    await run([
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', gitRevision(parent)]),
      '-m',
      message,
    ]),
  );
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

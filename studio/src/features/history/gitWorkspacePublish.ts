import type { PublishConnection } from '../../shared/publishConnection';
import type { PublishSource } from '../publishing/publishSource';
import { published } from '../publishing/publishFailure';
import { publishGit } from '../publishing/publishGit';
import { publishCommitMessage } from '../publishing/publishAttribution';
import { overlayPublishSource } from '../github/nativePublish';
import { gitWorkspaceBranch, gitRevision, gitWorkspaceLimits, type GitWorkspaceManifest } from './gitWorkspaceContract';
import assert from 'node:assert/strict';
import { gitWorkspaceContext, gitWorkspaceRun, gitWorkspaceCommit } from './gitWorkspaceObjects';
import { checkpointGitWorkspace } from './gitWorkspaceCheckpoint';
import { ReferencedError } from '../../shared/referencedError';

/** Publish the actual local ancestry; an explicit commit must never be silently squashed. */
export async function publishGitWorkspace(
  root: string,
  source: PublishSource,
  connection: PublishConnection,
  manifest: GitWorkspaceManifest,
  options: { readonly remote?: string } = {},
) {
  const branch = gitWorkspaceBranch(manifest);
  const remote = options.remote ?? `https://github.com/${manifest.repository}.git`;
  const expected = manifest.remote.find((entry) => entry.name === manifest.branch)?.head ?? '';
  const git = { ...source.git, authorization: connection.token };
  const run = gitWorkspaceRun(git);
  await verifyPublishHead(run, remote, manifest.branch, expected);
  const workspace = gitWorkspaceContext(root, connection);
  await importWorkspaceHead(run, workspace, manifest, remote);
  await verifyPublishAncestry(git, expected, branch.head);
  const tree = published(await overlayPublishSource(git, source, branch.head));
  const original = await run(['rev-parse', branch.head + '^{tree}']);
  const head = tree === original ? branch.head : await gitWorkspaceCommit(run, tree, [branch.head], publishCommitMessage(source.editor));
  if (head !== expected) {
    await run(['push', '--quiet', '--force-with-lease=refs/heads/' + manifest.branch + ':' + expected, remote, head + ':refs/heads/' + manifest.branch]);
  }
  const local = gitWorkspaceRun(workspace);
  await local(['fetch', '--quiet', '--update-shallow', git.directory, head]);
  const next = {
    ...manifest,
    draft: undefined,
    branches: manifest.branches.map((entry) => (entry.name === manifest.branch ? { ...entry, head: gitRevision(head) } : entry)),
    remote: [...manifest.remote.filter((entry) => entry.name !== manifest.branch), { name: manifest.branch, head }],
  };
  try {
    await checkpointGitWorkspace(workspace, manifest, next);
  } catch (error) {
    throw Object.assign(new ReferencedError('git.studio.publishCheckpoint'), { cause: error });
  }
  return { sha: head, url: `https://github.com/${manifest.repository}/commit/${head}` };
}

/**
 * Bring the workspace branch's head into a temporary repository that publishes or submits a review.
 * `run` carries that repository's own GitHub credentials; `remote` is the repository on GitHub.
 */
export async function importWorkspaceHead(
  run: ReturnType<typeof gitWorkspaceRun>,
  workspace: PublishSource['git'],
  manifest: GitWorkspaceManifest,
  remote: string,
) {
  const expected = manifest.remote.find((entry) => entry.name === manifest.branch)?.head ?? '';
  await fetchPublishBases(run, workspace, manifest, remote, expected);
  await run(['fetch', '--quiet', '--update-shallow', workspace.directory, gitWorkspaceBranch(manifest).head]);
}

async function verifyPublishHead(run: ReturnType<typeof gitWorkspaceRun>, remote: string, branch: string, expected: string) {
  const witnessed = (await run(['ls-remote', '--heads', remote, 'refs/heads/' + branch])).split('\t')[0] ?? '';
  if (witnessed !== expected) {
    throw new ReferencedError('git.studio.githubChanged');
  }
}

/**
 * Fetch, with this publish run's own credentials, the GitHub commits the workspace's
 * branch is built on, into refs of the temporary publish repository.
 *
 * Why: the workspace is a blobless partial clone (`--filter=blob:none`). Fetching its
 * head over the local transport sends every object the publish repository lacks, and
 * the workspace's upload-pack would have to lazily fetch the missing blobs from GitHub.
 * That child process carries no credentials (Git drops the GIT_CONFIG_* authorization
 * header from a local transport's environment), so a private repository failed with
 * "could not fetch <oid> from promisor remote"; Git 2.45+ also refuses lazy fetches in
 * upload-pack outright. With these commits held under refs, the publish repository
 * advertises them during negotiation (FETCH_HEAD alone is not advertised), and the
 * local fetch sends only objects the workspace created, all of which it has.
 *
 * Which commits: the branch's GitHub head when it exists (verifyPublishHead proved it
 * current), and every other GitHub head the workspace's branch contains (a new branch's
 * starting point, a merged branch). Blobless, like the workspace: trees decide what is
 * shared, and no file content is downloaded.
 */
async function fetchPublishBases(
  run: ReturnType<typeof gitWorkspaceRun>,
  workspace: PublishSource['git'],
  manifest: GitWorkspaceManifest,
  remote: string,
  expected: string,
) {
  assert(manifest.remote.length <= gitWorkspaceLimits.branches, 'GitHub heads are bounded by the branch limit');
  const head = gitWorkspaceBranch(manifest).head;
  const bases = expected ? [expected] : [];
  for (const entry of manifest.remote) {
    if (entry.head !== expected && !bases.includes(entry.head)) {
      const contained = await publishGit(workspace, ['merge-base', '--is-ancestor', entry.head, head]);
      if (contained.ok) {
        bases.push(entry.head);
      }
    }
  }
  if (bases.length === 0) {
    return;
  }
  assert(bases.length <= gitWorkspaceLimits.branches, 'Publish bases are bounded by the branch limit');
  const references = bases.map((base, index) => `+${gitRevision(base)}:refs/stacki/publish-base/${index}`);
  await run(['fetch', '--quiet', '--depth=301', '--filter=blob:none', '--no-tags', remote, ...references]);
}

async function verifyPublishAncestry(git: PublishSource['git'], expected: string, head: string) {
  if (!expected) {
    return;
  }
  const ancestor = await publishGit(git, ['merge-base', '--is-ancestor', expected, head]);
  if (!ancestor.ok) {
    throw new ReferencedError('git.studio.publishBehind');
  }
}

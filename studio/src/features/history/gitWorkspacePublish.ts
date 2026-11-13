import type { PublishConnection } from '../../shared/publishConnection';
import type { PublishSource } from '../publishing/publishSource';
import { published } from '../publishing/publishFailure';
import { publishGit } from '../publishing/publishGit';
import { overlayPublishSource } from '../github/nativePublish';
import { gitWorkspaceBranch, gitRevision, type GitWorkspaceManifest } from './gitWorkspaceContract';
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
  await run(['fetch', '--quiet', '--update-shallow', workspace.directory, branch.head]);
  await verifyPublishAncestry(git, remote, expected, branch.head);
  const tree = published(await overlayPublishSource(git, source, branch.head));
  const original = await run(['rev-parse', branch.head + '^{tree}']);
  const head = tree === original ? branch.head : await gitWorkspaceCommit(run, tree, [branch.head], 'Publish website from Stacki Studio');
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

async function verifyPublishHead(run: ReturnType<typeof gitWorkspaceRun>, remote: string, branch: string, expected: string) {
  const witnessed = (await run(['ls-remote', '--heads', remote, 'refs/heads/' + branch])).split('\t')[0] ?? '';
  if (witnessed !== expected) {
    throw new ReferencedError('git.studio.githubChanged');
  }
}

async function verifyPublishAncestry(git: PublishSource['git'], remote: string, expected: string, head: string) {
  if (!expected) {
    return;
  }
  await gitWorkspaceRun(git)(['fetch', '--quiet', '--depth=301', '--filter=blob:none', '--no-tags', remote, expected]);
  const ancestor = await publishGit(git, ['merge-base', '--is-ancestor', expected, head]);
  if (!ancestor.ok) {
    throw new ReferencedError('git.studio.publishBehind');
  }
}

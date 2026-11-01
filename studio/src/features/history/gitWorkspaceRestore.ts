import { parsePublishConnection } from '../../shared/publishConnection';
import { record } from '../../shared/validation';
import { published } from '../publishing/publishFailure';
import { gitRevision, gitWorkspaceBranch, parseGitWorkspaceManifest, type GitWorkspaceManifest } from './gitWorkspaceContract';
import type { PublishGit } from '../publishing/publishGit';
import { gitWorkspaceContext, initializeGitWorkspace } from './gitWorkspaceObjects';
import { writeLocalGitWorkspace } from './gitWorkspaceStorage';
import { prepareGitWorkspaceCheckout } from './gitWorkspaceCheckout';

/** Recover unpublished commits and the active draft before restoring newer CRDT updates. */
export async function restoreGitWorkspace(root: string, input: unknown, baseline: string) {
  const data = record(input);
  if (data['workspace'] === undefined) {
    return;
  }
  const manifest = parseGitWorkspaceManifest(data['workspace']);
  const connection = published(parsePublishConnection(input));
  if (manifest.repository !== connection.repository) {
    throw new Error('Git checkpoint belongs to another repository.');
  }
  const git = gitWorkspaceContext(root, connection);
  await initializeGitWorkspace(git, connection, manifest);
  await restoreGitWorkspaceCheckout(git, manifest, baseline);
}

/** Bootstrap has already restored baseline files; only divergent drafts need checkout. */
export async function restoreGitWorkspaceCheckout(git: PublishGit, manifest: GitWorkspaceManifest, baseline: string): Promise<void> {
  const target = gitRevision(manifest.draft ?? gitWorkspaceBranch(manifest).head);
  if (target === gitRevision(baseline)) {
    // Asking a partial clone for this identical tree would fetch every blob again.
    await writeLocalGitWorkspace(git.root, manifest);
    return;
  }
  const checkout = await prepareGitWorkspaceCheckout(git, baseline, target);
  try {
    await checkout.apply();
    await writeLocalGitWorkspace(git.root, manifest);
  } finally {
    await checkout.dispose();
  }
}

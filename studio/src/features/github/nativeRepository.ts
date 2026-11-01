import { gitWorkspaceBranch } from '../history/gitWorkspaceContract';
import { gitWorkspaceContext, gitWorkspaceRun } from '../history/gitWorkspaceObjects';
import { readGitWorkspace } from '../history/gitWorkspaceStorage';
import { publishGitWorkspace } from '../history/gitWorkspacePublish';
import type { GitHubRepository, RepositoryAccess } from './github';
import type { RemoteRepository } from './remoteRepository';
import type { PublishSource } from '../publishing/publishSource';
import { nativePublish } from './nativePublish';
import { nativeReview } from './nativeReview';
import { ok } from '../../../vendor/stacki/shared/core/result';
import { publishFailure } from '../publishing/publishFailure';

/** Keep Node's Git transport out of the Worker bundle that owns the GitHub App private key. */
export class NativeRepository implements RepositoryAccess {
  constructor(
    private readonly access: GitHubRepository | RemoteRepository,
    private readonly root?: string,
  ) {}
  async historyConnection() {
    const connection = await this.access.publishConnection();
    const workspace = this.root ? await readGitWorkspace(this.root) : undefined;
    return connection.ok && workspace ? ok({ ...connection.value, branch: workspace.branch }) : connection;
  }
  incoming(base: string) {
    return this.access.incoming(base);
  }
  acceptBase(sha: string) {
    return this.access.acceptBase(sha);
  }
  async review(source: PublishSource, expectedHead: string) {
    const grant = await this.access.reviewConnection().then(ok, publishFailure);
    if (!grant.ok) {
      return grant;
    }
    if (!grant.value.ok) {
      return grant.value;
    }
    const workspace = this.root ? await readGitWorkspace(this.root) : undefined;
    if (this.root && workspace) {
      const localParent = gitWorkspaceBranch(workspace).head;
      const local = gitWorkspaceContext(this.root, grant.value.value);
      const imported = await gitWorkspaceRun(source.git)(['fetch', '--quiet', '--update-shallow', local.directory, localParent]).then(ok, publishFailure);
      if (!imported.ok) {
        return imported;
      }
      return nativeReview(source, expectedHead, { ...grant.value.value, branch: workspace.branch }, { localParent });
    }
    return nativeReview(source, expectedHead, grant.value.value);
  }
  async commit(source: PublishSource, expectedHead: string) {
    const grant = await this.access.publishConnection().then(ok, publishFailure);
    if (!grant.ok) {
      return grant;
    }
    if (!grant.value.ok) {
      return grant.value;
    }
    const workspace = this.root ? await readGitWorkspace(this.root) : undefined;
    if (this.root && workspace) {
      return publishGitWorkspace(this.root, source, grant.value.value, workspace).then(ok, publishFailure);
    }
    return nativePublish(source, expectedHead, grant.value.value);
  }
}

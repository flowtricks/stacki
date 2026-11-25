import { AsyncLocalStorage } from 'node:async_hooks';
import { readWorkspaceId } from '../project/projectIdentity';
import { ReferencedError } from '../../shared/referencedError';

const leases = new AsyncLocalStorage<{ readonly root: string; readonly identity: string }>();
const operations = new Map<string, 'working' | 'recovery'>();
export function gitWorkspaceNeedsRecovery(root: string): boolean {
  return operations.get(root) === 'recovery';
}
export function gitWorkspaceBusy(root: string): boolean {
  return operations.has(root);
}
export function setGitWorkspaceBusy(root: string, state: 'working' | 'recovery' | 'idle') {
  if (state === 'idle') {
    operations.delete(root);
  } else {
    if (operations.size >= 100 && !operations.has(root)) {
      throw new ReferencedError('git.studio.tooManyWorkspaces');
    }
    operations.set(root, state);
  }
}
export async function withGitWorkspaceLease<T>(root: string, expected: string | undefined, work: () => Promise<T>): Promise<T> {
  if (gitWorkspaceNeedsRecovery(root)) {
    throw new ReferencedError('git.studio.storageNeedsRecovery');
  }
  const identity = (await readWorkspaceId(root)) ?? '';
  if (identity.startsWith('git-') && expected !== identity) {
    throw new ReferencedError('git.studio.sharedBranchChanged');
  }
  return leases.run({ root, identity }, work);
}
export async function verifyGitWorkspaceLease(root: string): Promise<void> {
  if (gitWorkspaceNeedsRecovery(root)) {
    throw new ReferencedError('git.studio.storageNeedsRecovery');
  }
  const lease = leases.getStore();
  if (lease?.root === root && lease.identity !== ((await readWorkspaceId(root)) ?? '')) {
    throw new ReferencedError('git.studio.sharedBranchChangedSave');
  }
}

export function isGitWorkspaceRead(pathname: string): boolean {
  return ['/studio/api/git/info', '/studio/api/git/status', '/studio/api/git/incoming'].includes(pathname);
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { readWorkspaceId } from '../project/projectIdentity';

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
      throw new Error('Too many active Git workspaces.');
    }
    operations.set(root, state);
  }
}
export async function withGitWorkspaceLease<T>(root: string, expected: string | undefined, work: () => Promise<T>): Promise<T> {
  if (gitWorkspaceNeedsRecovery(root)) {
    throw new Error('Git storage needs recovery. Leave Studio idle so its container can restart.');
  }
  const identity = (await readWorkspaceId(root)) ?? '';
  if (identity.startsWith('git-') && expected !== identity) {
    throw new Error('The shared branch changed. Reload Studio before editing.');
  }
  return leases.run({ root, identity }, work);
}
export async function verifyGitWorkspaceLease(root: string): Promise<void> {
  if (gitWorkspaceNeedsRecovery(root)) {
    throw new Error('Git storage needs recovery. Leave Studio idle so its container can restart.');
  }
  const lease = leases.getStore();
  if (lease?.root === root && lease.identity !== ((await readWorkspaceId(root)) ?? '')) {
    throw new Error('The shared branch changed before this edit could be saved. Reload Studio.');
  }
}

export function isGitWorkspaceRead(pathname: string): boolean {
  return ['/studio/api/git/info', '/studio/api/git/status', '/studio/api/git/incoming'].includes(pathname);
}

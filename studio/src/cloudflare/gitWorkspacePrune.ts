import type { Environment } from './environment';
import type { GitWorkspaceManifest } from '../features/history/gitWorkspaceContract';

// Old document epochs are redundant after the draft is checkpointed in Git. Keep
// recent epochs for in-flight bootstrap requests, and bound retained namespaces.
export async function pruneGitDrafts(environment: Environment, current: GitWorkspaceManifest | undefined, next: GitWorkspaceManifest): Promise<void> {
  const inventory = await environment.DRAFTS.list({
    prefix: 'workspaces/',
    delimiter: '/',
    limit: 129,
  });
  if (inventory.truncated) {
    throw new Error('Draft storage exceeds its 128-workspace limit.');
  }
  const retained = new Set([
    ...(current?.branches.map((branch) => `workspaces/${branch.workspace}/`) ?? []),
    ...next.branches.map((branch) => `workspaces/${branch.workspace}/`),
  ]);
  let count = inventory.delimitedPrefixes.length;
  for (const prefix of inventory.delimitedPrefixes) {
    if (!retained.has(prefix) && (await pruneGitDraft(environment, prefix))) {
      count--;
    }
  }
  if (count >= 128) {
    throw new Error('Draft storage is busy. Retry after older workspaces expire.');
  }
}
async function pruneGitDraft(environment: Environment, prefix: string): Promise<boolean> {
  const cutoff = Date.now() - 30 * 60_000;
  let cursor: string | undefined;
  // Project storage already caps its inventory at 10,000 objects. Collect first
  // so a recent write prevents removal of any part of that workspace.
  const keys: string[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await environment.DRAFTS.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (result.objects.some((object) => object.uploaded.getTime() >= cutoff)) {
      return false;
    }
    keys.push(...result.objects.map((object) => object.key));
    if (!result.truncated) {
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await environment.DRAFTS.delete(keys.slice(offset, offset + 1000));
      }
      return true;
    }
    if (!result.cursor || cursor === result.cursor) {
      throw new Error('Incomplete draft storage inventory.');
    }
    cursor = result.cursor;
  }
  throw new Error('Draft storage exceeds its object limit.');
}

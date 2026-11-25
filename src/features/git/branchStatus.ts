/*
 * Which branch the project is on, and whether that is the one publishing is expected to send.
 *
 * Publish sends the current branch and Deploy ships whatever is on disk, so standing on a branch you
 * did not mean to (a tool made it, or a switch you forgot) is easy to miss. This is the one place that
 * decides what the top bar shows and whether Publish asks first; the chip and the warning both read it,
 * so they can never disagree about what counts as "somewhere unexpected".
 *
 * Pure: it takes what `git:info` reported and returns a value, so every case is a plain test.
 */
import { assert } from '../../../shared/core/assert';
import type { IpcResults } from '../../../shared/ipc/ipcResults';

/** What the chip draws. Data exists only in the states that have it. */
export type BranchStatus =
  /** Nothing is known yet (the first read has not answered): the chip paints a placeholder shape. */
  | { readonly kind: 'unknown' }
  /** Not a repository, or no commits yet: there is no branch to name, so nothing is drawn. */
  | { readonly kind: 'hidden' }
  /** On the default branch, or the default is not known so no other branch can be called unexpected: quiet. */
  | { readonly kind: 'default'; readonly name: string }
  /** On any other branch: a warning state. */
  | { readonly kind: 'other'; readonly name: string; readonly defaultName: string }
  /** Not on a branch at all (git calls it a detached HEAD). */
  | { readonly kind: 'detached'; readonly defaultName: string; readonly canSwitch: boolean };

/** What git prints for HEAD when it points at a commit and not at a branch. */
const DETACHED_HEAD = 'HEAD';

/** The name used for the default branch only when a detached HEAD is the sole thing known about the project. */
const FALLBACK_DEFAULT_BRANCH = 'main';

type RepositoryInfo = Extract<IpcResults['git:info'], { readonly isRepo: true }>;

/** The branch publishing is expected to send: the remote's default, else main or master, else unknown. */
export function defaultBranchOf(info: Pick<RepositoryInfo, 'defaultBranch' | 'trunk'>): string | undefined {
  return info.defaultBranch ?? info.trunk;
}

export function branchStatusOf(info: IpcResults['git:info'] | undefined): BranchStatus {
  if (info === undefined) {
    return { kind: 'unknown' };
  }
  if (!info.isRepo) {
    return { kind: 'hidden' };
  }
  // A repository with no commits has no branch yet (git still prints a name, but nothing can be published from it).
  if (info.head === undefined || info.branch.length === 0) {
    return { kind: 'hidden' };
  }
  const known = defaultBranchOf(info);
  if (info.branch === DETACHED_HEAD) {
    const defaultName = known ?? info.branches[0] ?? FALLBACK_DEFAULT_BRANCH;
    assert(defaultName.length > 0, 'branchStatusOf: a detached HEAD names a branch to go back to');
    return { kind: 'detached', defaultName, canSwitch: info.branches.includes(defaultName) };
  }
  if (known === undefined || info.branch === known) {
    return { kind: 'default', name: info.branch };
  }
  return { kind: 'other', name: info.branch, defaultName: known };
}

/** Whether Publish must ask before starting from here. The default branch and an unknown one never ask. */
export function needsBranchWarning(status: BranchStatus): status is Extract<BranchStatus, { readonly kind: 'other' | 'detached' }> {
  return status.kind === 'other' || status.kind === 'detached';
}

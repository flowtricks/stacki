// Branch work the git panel does beyond the plain git commands: parking
// uncommitted changes when switching branches, the log, and the identity
// commits are made under.

import { definedFields } from '../../shared/core/boundary';
import type { IpcPayloads } from '../../shared/ipc/ipcPayloads';
import * as gitHistory from './gitHistory';
import { git } from '../lib/nodeTools';
import { ensureExcluded } from '../lib/projectExclusions';

// Work in progress, set aside under the branch it belongs to.
//
// Git will not switch branches over changes it would have to overwrite, and
// the usual advice — commit first — asks for a commit that only exists to
// make git cooperate. So the changes are put away against the branch being
// left, and taken back out when that branch is next opened. They are never
// lost and never travel to a branch they were not written on.
//
// The tag is what makes this safe: only a stash Stacki wrote is ever restored,
// so someone's own `git stash` is left alone.
// Tags already in people's stash lists name a detached HEAD `null`; the
// spelling stays so those are still found.
export const parkTag = (branch: string | undefined) => `stacki:park:${branch ?? 'null'}`;

export async function isDirty(projectPath: string) {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

// The most recent parking for this branch, as a ref that is still valid right
// now — stash indices shift as entries come and go, so this is resolved
// immediately before it is used.
export async function parkedRef(projectPath: string, branch: string | undefined) {
  const { stdout } = await git(projectPath, ['stash', 'list', '--format=%gd%x09%gs']);
  const tag = parkTag(branch);
  for (const line of stdout.split('\n')) {
    const [ref, subject] = line.split('\t');
    if (ref && subject && subject.trim().endsWith(tag)) {
      return ref.trim();
    }
  }
  return undefined;
}

export async function parkBranch(projectPath: string, branch: string | undefined) {
  await preserveIgnoredPaths(projectPath);
  if (!(await isDirty(projectPath))) {
    return false;
  }
  await git(projectPath, ['stash', 'push', '--include-untracked', '-m', parkTag(branch)]);
  return true;
}

// Branches can disagree about .gitignore. Keep existing generated files ignored
// locally so a return trip cannot stash the other branch's runtime dependencies.
async function preserveIgnoredPaths(projectPath: string): Promise<void> {
  const { stdout } = await git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  const paths = stdout.split('\0').filter(Boolean);
  if (paths.length > 4096) {
    throw new Error('Too many ignored paths to preserve while switching branches');
  }
  // Shared Stacki metadata must remain versioned; only its known generated
  // directories belong in the local exclusions maintained by ensureExcluded.
  const ignoredPaths = paths.filter((entry) => !entry.startsWith('.stacki/'));
  if (!ensureExcluded(projectPath, { ignoredPaths })) {
    throw new Error('Could not preserve generated files before switching branches');
  }
}

export async function unparkBranch(projectPath: string, branch: string | undefined) {
  const ref = await parkedRef(projectPath, branch);
  if (!ref) {
    return { restored: false };
  }
  // Another tool may have edited the destination. Never apply or unwind a stash
  // over those edits: the recovery below is only safe on an initially clean tree.
  if (await isDirty(projectPath)) {
    return {
      restored: false,
      error: `Your work on "${branch}" is still parked because this branch has local changes.`,
    };
  }
  try {
    await git(projectPath, ['stash', 'pop', '--index', ref]);
    return { restored: true };
  } catch {
    // A pop that cannot apply leaves conflict markers in the files. That is a
    // reasonable state for someone at a terminal and a bad one for an editor
    // that will parse those files a moment later — the page would read as
    // broken markup. The tree goes back to the branch as committed, and the
    // work stays parked, which is the state it was already in. Safe because
    // the switch left the tree clean, so there is nothing else here to lose.
    try {
      await git(projectPath, ['reset', '--hard', 'HEAD']);
      await git(projectPath, ['clean', '-fd']);
    } catch {
      /* nothing better to try */
    }
    return {
      restored: false,
      error:
        `Your work on "${branch}" is still parked — it could not be put back automatically ` +
        'because the branch has changed underneath it. ' +
        'It is safe: recover it with `git stash list` and `git stash pop`.',
    };
  }
}

export async function currentBranch(projectPath: string) {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return undefined;
  }
}

// --- Reading history -------------------------------------------------------
//
// The panel gets files already described (see describeFile): "Home" rather
// than "src/pages/index.astro". Done here rather than in the renderer because
// this is the side that knows the project's shape, and because it keeps the
// panel about drawing rather than about interpreting paths.

export async function readGitLog(payload: IpcPayloads['git:log']) {
  const result = await gitHistory.log(git, definedFields(payload));
  const commits = result.commits.map((commit) => ({
    ...commit,
    files: commit.files === undefined ? undefined : gitHistory.describeFiles(commit.files),
  }));
  return { ...result, commits };
}

export async function readGitIdentity(projectPath: string) {
  const identity: { branch: string; head: string | undefined; userEmail: string | undefined } = {
    branch: '',
    head: undefined,
    userEmail: undefined,
  };
  try {
    identity.branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    identity.branch = '(no commits yet)';
  }
  try {
    // What HEAD actually points at. The history panel reloads when this moves,
    // which is how a commit made from the chip shows up in the timeline
    // without the panel having to know the chip exists.
    identity.head = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    identity.head = undefined; // no commits yet
  }
  try {
    // Whose commits are "yours". Git records an author on every commit, and on
    // your own machine that is nearly always you — "Timothy Ricks changed the
    // hero" reads oddly about yourself.
    identity.userEmail = (await git(projectPath, ['config', 'user.email'])).stdout.trim() || undefined;
  } catch {
    identity.userEmail = undefined;
  }
  return identity;
}

export async function readGitParked(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await git(projectPath, ['stash', 'list', '--format=%gs']);
    const tag = /stacki:park:(.+)$/;
    return [
      ...new Set(
        stdout
          .split('\n')
          .map((line) => (line.match(tag) || [])[1])
          .filter((branch): branch is string => branch !== undefined)
          .map((branch) => branch.trim()),
      ),
    ];
  } catch {
    return []; // No stashes, or not a repository yet.
  }
}

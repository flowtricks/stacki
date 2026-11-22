// Questions about the repository's own state that several git operations must ask before they act: is an operation unfinished, is the
// branch born yet, where does the project sit inside the repository, and is this branch name one git will accept.
//
// Each answer comes from git itself (never from parsing a path by hand), and each takes the `git` runner as its first argument so tests
// run it against real repositories exactly as the app does.

import fs from 'fs';
import path from 'path';

import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import type { Git } from './git';

export type UnfinishedOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

// Git records an unfinished operation as a file or folder in the git directory; these are the names it uses for each.
const OPERATION_MARKERS: readonly (readonly [UnfinishedOperation, string])[] = [
  ['merge', 'MERGE_HEAD'],
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
];

/** Which operation git is part-way through here (a merge with conflicts, a rebase, a cherry-pick), or undefined when none is. */
export async function unfinishedOperation(git: Git, projectPath: string): Promise<UnfinishedOperation | undefined> {
  const gitDirectory = (await git(projectPath, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  for (const [operation, marker] of OPERATION_MARKERS) {
    if (fs.existsSync(path.join(gitDirectory, marker))) {
      return operation;
    }
  }
  return undefined;
}

/** Refuses to go on while an operation is unfinished: switching, merging or restoring over one would bury it. */
export async function requireNoUnfinishedOperation(git: Git, projectPath: string): Promise<void> {
  const operation = await unfinishedOperation(git, projectPath);
  if (operation !== undefined) {
    throw new ReferencedError('git.error.operationInProgress', { operation });
  }
}

/**
 * The branch HEAD names, and whether it has a commit yet. A repository with no commits has a branch name (`main`) and no HEAD commit, and
 * `rev-parse --abbrev-ref HEAD` fails there, so the name is read from the symbolic ref instead. Detached HEAD has no branch: `undefined`.
 */
export async function readHead(git: Git, projectPath: string): Promise<{ readonly branch: string | undefined; readonly born: boolean }> {
  let branch: string | undefined;
  try {
    branch = (await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || undefined;
  } catch {
    branch = undefined; // Detached: symbolic-ref exits 1 without output.
  }
  let born = true;
  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  } catch {
    born = false;
  }
  return { branch, born };
}

/**
 * The repository-relative folder the project sits in, with its trailing slash, or '' when the project is the repository root.
 * `git status --porcelain` and `git log --name-status` report root-relative paths, while every command the app runs uses the project
 * folder as its working directory, so a project inside a larger repository (a monorepo) must strip this prefix from what git reports.
 */
export async function projectPrefix(git: Git, projectPath: string): Promise<string> {
  return (await git(projectPath, ['rev-parse', '--show-prefix'])).stdout.trim();
}

/**
 * Whether git accepts `name` as a branch to create or name. Asked of git (`check-ref-format --branch`) so the rules cannot drift from its
 * own, and refused outright when it starts with a dash, which a later command would read as an option. Throws a ReferencedError so the
 * person is told which name was refused; an existing ref that would clash is reported by `create` as `branchNameConflict`.
 */
export async function requireValidBranchName(git: Git, projectPath: string, name: string): Promise<void> {
  // `check-ref-format --branch` also expands `@`, `@{-1}` and similar shorthand to a real branch, and old versions accept HEAD; neither is a name.
  if (name.startsWith('-') || name.trim() !== name || name.length === 0 || name === '@' || name.includes('@{') || name === 'HEAD') {
    throw new ReferencedError('git.error.branchNameInvalid');
  }
  try {
    await git(projectPath, ['check-ref-format', '--branch', name]);
  } catch {
    throw new ReferencedError('git.error.branchNameInvalid');
  }
}

/** Whether a local branch of exactly this name exists. */
export async function branchExists(git: Git, projectPath: string, name: string): Promise<boolean> {
  try {
    await git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

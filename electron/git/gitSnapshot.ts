// Moving the working tree through time: saving a version, and going back to
// one.
//
// gitHistory.js only reads and gitBranches.js is about branches; these are the
// operations that change what is on disk right now. They are together because
// they are the same promise from two directions — "this is safe to try,
// because you can get back to here" is only true if both halves work.
//
// The rule the restores follow, and the reason they are safe to offer to
// someone who does not know git: **nothing is ever thrown away silently.**
// Restoring a file leaves the old contents as an uncommitted change, which the
// user can discard. Restoring the whole project parks what was there first, so
// the work is recoverable even though the tree no longer shows it. Neither
// rewrites history — going back is itself something you can come back from.

import { described, type MessageRef } from '../../shared/properties/i18n/messageRef';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { assert } from '../../shared/core/assert';
import { MAIN_LIMITS } from '../lib/mainLimits';
import type { Git } from './git';
import { projectPrefix, requireNoUnfinishedOperation, unfinishedOperation } from './gitState';

/**
 * Save a version.
 *
 * `paths` absent means everything in the project folder, which is what the button has always done and still does by default; picking is
 * the opt-in. Given a list, only those files are saved and everything else stays changed on disk exactly as it was.
 *
 * Why the details below:
 * - The message is trimmed and bounded: a blank one falls back to the default (git refuses an empty message), and one past the limit
 *   would not fit a process argument.
 * - `--literal-pathspecs`: a page named `[slug].astro` or `*.astro` is a file name here, never a pattern.
 * - "Everything" is `add -A -- .` and `commit -- .`, scoped to the project folder: a project inside a larger repository must not save
 *   (or sweep in already-staged) changes that belong to its sibling projects.
 * - A merge in progress is finished by a plain commit; git refuses a partial one then, so the pathspec is dropped and every staged file goes.
 * - A cherry-pick, revert or rebase in progress is refused: committing in the middle of one would write a commit the operation did not plan.
 */
async function commit(
  git: Git,
  {
    projectPath,
    message,
    paths,
  }: {
    readonly projectPath: string;
    readonly message?: string;
    readonly paths?: readonly unknown[];
  },
): Promise<{ ok: true; files: number | undefined }> {
  const subject = message?.trim() || 'Update from Stacki';
  assert(subject.length > 0, 'commit: the subject is never empty');
  if (subject.length > MAIN_LIMITS.commitMessageCharsMax || subject.includes('\0')) {
    throw new ReferencedError('git.error.messageTooLong');
  }
  const chosen = Array.isArray(paths) ? [...new Set(paths.filter(Boolean).map(String))] : undefined;
  if (chosen && !chosen.length) {
    throw new ReferencedError('git.error.commitNothingPicked');
  }
  const operation = await unfinishedOperation(git, projectPath);
  if (operation !== undefined && operation !== 'merge') {
    throw new ReferencedError('git.error.operationInProgress', { operation });
  }
  const commitOptions = { timeout: MAIN_LIMITS.commitTimeoutMs };
  if (operation === 'merge') {
    await git(projectPath, ['--literal-pathspecs', 'add', '--all', '--', ...(chosen ?? ['.'])]);
    await git(projectPath, ['commit', '-m', subject], commitOptions);
    return { ok: true, files: chosen?.length };
  }
  if (!chosen) {
    await git(projectPath, ['add', '--all', '--', '.']);
    await git(projectPath, ['commit', '-m', subject, '--', '.'], commitOptions);
    return { ok: true, files: undefined };
  }
  // `--all` on the pathspec so a file the user DELETED is staged as a deletion; plain `git add` on a missing path is an error.
  // A pathspec on `commit` ignores whatever else happens to be staged, which is exactly what "only these" has to mean.
  await withPathspec(chosen, async (pathspec) => {
    await git(projectPath, ['--literal-pathspecs', 'add', '--all', ...pathspec.add]);
    await git(projectPath, ['--literal-pathspecs', 'commit', '-m', subject, ...pathspec.commit], commitOptions);
  });
  return { ok: true, files: chosen.length };
}

/**
 * The pathspec arguments for a list of paths: the list itself when it is short, or a file git reads when it is long (a process argument
 * list has a hard size limit, and a project may have thousands of changed files). The file is removed afterwards, whatever happens.
 * `add` and `commit` take it differently: `commit` needs `--only` for a pathspec file to mean "only these".
 */
async function withPathspec<Value>(
  paths: readonly string[],
  work: (pathspec: { readonly add: readonly string[]; readonly commit: readonly string[] }) => Promise<Value>,
): Promise<Value> {
  if (paths.length <= MAIN_LIMITS.pathspecArgumentsMax) {
    return work({ add: ['--', ...paths], commit: ['--', ...paths] });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-pathspec-'));
  const file = path.join(directory, 'paths');
  try {
    await fs.writeFile(file, paths.join('\0'), 'utf8');
    const flags = [`--pathspec-from-file=${file}`, '--pathspec-file-nul'];
    return await work({ add: flags, commit: ['--only', ...flags] });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Put one file back to how it was at `ref`.
 *
 * Deliberately the least dramatic thing that works: the old contents land as
 * an ordinary uncommitted change. Nothing is committed, no history moves, and
 * undoing it is the same as undoing any other edit. A file that did not exist
 * at that commit is a question this cannot answer by writing something, so it
 * says so instead.
 */
async function restoreFile(
  git: Git,
  { projectPath, ref, path: filePath }: { readonly projectPath: string; readonly ref: string; readonly path: string },
): Promise<{ ok: boolean; missing?: boolean; message?: string; messageRef?: MessageRef | undefined }> {
  const commitId = await resolveCommit(git, projectPath, ref);
  try {
    await git(projectPath, ['cat-file', '-e', `${commitId}:${await inRepository(git, projectPath, filePath)}`]);
  } catch {
    return {
      ok: false,
      missing: true,
      ...described('git.error.restoreMissing'),
    };
  }
  await git(projectPath, ['--literal-pathspecs', 'checkout', commitId, '--', filePath]);
  return { ok: true };
}

/**
 * Put the whole project back to how it was at `ref`.
 *
 * The tree is moved, not the branch: this lands as a set of uncommitted
 * changes on the branch you are on, which the user can look at, keep, or
 * abandon. The alternative — moving the branch itself — would silently
 * discard every commit made since, and there would be nothing on screen to
 * say it had happened.
 *
 * `park` is passed in (it lives in gitParking.ts, over the stash) and is called
 * first whenever there is anything to lose. Without that, restoring over
 * uncommitted work would destroy it with no way back.
 */
async function restoreProject(
  git: Git,
  { projectPath, ref, park }: { readonly projectPath: string; readonly ref: string; readonly park?: () => Promise<boolean> },
): Promise<{ ok: boolean; parked: boolean }> {
  const commitId = await resolveCommit(git, projectPath, ref);
  await requireNoUnfinishedOperation(git, projectPath);
  const dirty = (await git(projectPath, ['status', '--porcelain'])).stdout.trim().length > 0;
  let parked = false;
  if (dirty) {
    if (!park) {
      throw new ReferencedError('git.error.restoreUnsaved');
    }
    parked = await park();
  }
  // `read-tree -u --reset`, and not `checkout <ref> -- .`.
  //
  // A checkout by pathspec only writes the files that are IN the commit. A
  // file added afterwards is tracked now and absent there, so it matches
  // nothing and simply stays — and `clean` will not take it either, because
  // clean removes untracked files and this one is tracked. The result is the
  // old project plus whatever has appeared since: a state that never existed,
  // presented as "how it was".
  //
  // read-tree sets the index and the working tree to exactly this commit,
  // deletions included, and leaves HEAD where it is — so the branch does not
  // move and the difference shows up as ordinary staged changes the user can
  // look at, keep, or throw away.
  //
  // Inside a larger repository (a monorepo) read-tree would reset the sibling projects as well, so the restore is limited to this folder.
  if ((await projectPrefix(git, projectPath)) === '') {
    await git(projectPath, ['read-tree', '-u', '--reset', commitId]);
  } else {
    await git(projectPath, ['restore', `--source=${commitId}`, '--staged', '--worktree', '--', '.']);
  }
  return { ok: true, parked };
}

/**
 * The full commit id a name stands for, or a refusal. A ref the renderer sent is data: one that starts with a dash would be read by git as
 * an option, and one that names nothing would fail with git's own wording. Resolving first means every later command gets a hash.
 */
async function resolveCommit(git: Git, projectPath: string, ref: string): Promise<string> {
  if (ref.startsWith('-') || ref.length === 0) {
    throw new ReferencedError('git.error.refInvalid');
  }
  try {
    const id = (await git(projectPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim();
    assert(/^[0-9a-f]{40,64}$/.test(id), 'resolveCommit: git returned a commit id');
    return id;
  } catch {
    throw new ReferencedError('git.error.refInvalid');
  }
}

/** A project-relative path as `<commit>:<path>` expects it: from the repository root, so a project inside a larger repository still finds its file. */
async function inRepository(git: Git, projectPath: string, filePath: string): Promise<string> {
  return `${await projectPrefix(git, projectPath)}${filePath}`;
}

export { commit, restoreFile, restoreProject, resolveCommit };

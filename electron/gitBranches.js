// Merging a branch and deleting one.
//
// Both are one git command with a handful of refusals behind it, and the
// refusals are the whole job: git says "not fully merged" and "would be
// overwritten by merge" to someone at a terminal who can then decide what to
// do. In an editor there is no terminal and no decision offered — the porcelain
// arrives as a red box quoting a command the user never ran. So each refusal
// worth acting on is recognised here and turned into either a sentence that
// says what to do instead, or a question the UI can ask.
//
// Kept out of main.js so the behaviour can be tested against a real repository
// (test/git-branches.js) rather than only through the app.
//
// `git` is passed in rather than imported: main.js runs git through a PATH it
// has had to repair for the packaged app, and the tests run it plainly.

/** Whether the working tree has anything uncommitted in it. */
async function isDirty(git, projectPath) {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

async function currentBranch(git, projectPath) {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Fold `branch` into the branch currently checked out.
 *
 * Named for the argument git takes, so "merge home-test" means what
 * `git merge home-test` means — the direction is never something to work out
 * from where a button sits.
 *
 * Returns `{ ok, into, changed }`. `changed` is false for a merge that moved
 * nothing: reporting "merged" there would suggest work arrived that was
 * already present.
 */
async function mergeBranch(git, { projectPath, branch }) {
  const into = await currentBranch(git, projectPath);
  if (branch === into) {
    throw new Error(`"${branch}" is the branch you are on — there is nothing to merge into.`);
  }
  // A merge writes into the working tree, and uncommitted work sitting there is
  // exactly what it would have to write over. Git refuses too, but only after
  // it has started and in words about strategies; this says it first.
  if (await isDirty(git, projectPath)) {
    throw new Error(
      `Commit or park your changes on "${into}" first — a merge needs a clean tree to write into.`
    );
  }
  const before = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  try {
    // --no-edit: a merge commit here must not open an editor nobody is sitting
    // at. Git still fast-forwards when it can.
    await git(projectPath, ['merge', '--no-edit', branch]);
  } catch (err) {
    // Which files git could not reconcile — asked of git rather than scraped
    // out of its prose, which comes in several shapes (content, modify/delete,
    // add/add) and on STDOUT, not stderr. Read before the abort, which is what
    // clears it.
    let files = [];
    try {
      files = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* no index to ask about — the merge never started */
    }
    // Conflict markers left in the files would be read as markup a moment
    // later and the page would come back broken with no visible cause — the
    // same reason unpark refuses to leave them. Put the branch back exactly as
    // it was and say where the work has to happen instead.
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* not a conflict, or already unwound — nothing to undo */
    }
    if (files.length) {
      throw new Error(
        `"${branch}" and "${into}" both changed ${files.slice(0, 4).join(', ')}` +
          (files.length > 4 ? ` and ${files.length - 4} more` : '') +
          `. Nothing was merged — "${into}" is exactly as it was. ` +
          `Resolve it in a terminal with \`git merge ${branch}\`.`
      );
    }
    throw new Error(
      String(err.stderr || err.message || '').trim() ||
        `Could not merge "${branch}" into "${into}".`
    );
  }
  const after = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, into, changed: after !== before };
}

/**
 * Delete `branch`.
 *
 * `-d` is git's safe form: it refuses a branch holding commits that exist
 * nowhere else, which is the one refusal that is a question rather than an
 * error. That one comes back as `{ ok: false, unmerged: true, message }` for
 * the UI to ask about — returned rather than thrown, because a rejection
 * crossing IPC arrives as a bare string with nothing to branch on. Forcing past
 * it is a second, separately asked-for call with `force`.
 */
async function deleteBranch(git, { projectPath, branch, force }) {
  const here = await currentBranch(git, projectPath);
  if (branch === here) {
    throw new Error(`"${branch}" is the branch you are on — switch to another one first.`);
  }
  try {
    await git(projectPath, ['branch', force ? '-D' : '-d', branch]);
  } catch (err) {
    const detail = String(err.stderr || err.message || '');
    if (/not fully merged/i.test(detail)) {
      return {
        ok: false,
        unmerged: true,
        message: `"${branch}" has commits that aren't on any other branch. Deleting it loses them.`,
      };
    }
    // Checked out somewhere else — another worktree of this same repository.
    // Not the branch you are on, so the check above let it through, and git's
    // own wording leads with a path nobody asked about.
    const worktree = detail.match(/used by worktree at '([^']+)'/);
    if (worktree) {
      throw new Error(
        `"${branch}" is checked out in another worktree (${worktree[1]}). Close or switch that one first.`
      );
    }
    throw new Error(detail.trim() || `Could not delete "${branch}".`);
  }
  return { ok: true };
}

module.exports = { mergeBranch, deleteBranch };

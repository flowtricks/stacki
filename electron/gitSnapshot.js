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

/**
 * Save a version.
 *
 * `paths` absent means everything, which is what the button has always done
 * and still does by default — picking is the opt-in. Given a list, only those
 * files are saved and everything else stays changed on disk exactly as it was.
 */
async function commit(git, { projectPath, message, paths }) {
  const subject = message || 'Update from Stacki';
  const chosen = Array.isArray(paths) ? paths.filter(Boolean) : null;
  if (chosen && !chosen.length) {
    throw new Error('Nothing was picked to save — choose at least one file.');
  }
  if (!chosen) {
    await git(projectPath, ['add', '-A']);
    await git(projectPath, ['commit', '-m', subject]);
    return { ok: true, files: null };
  }
  // `--all` on the pathspec so a file the user DELETED is staged as a
  // deletion. Plain `git add` on a path that is no longer there is an error,
  // not the obvious thing, and a delete is one of the commonest edits an
  // editor like this makes.
  //
  // `--` before the paths, always: a file whose name could be read as a
  // revision would otherwise be taken as one, and git would save something
  // other than what was asked for.
  await git(projectPath, ['add', '--all', '--', ...chosen]);
  // A pathspec on `commit` ignores whatever else happens to be staged, which
  // is exactly what "only these" has to mean — otherwise a file staged
  // earlier by something else rides along unnoticed.
  await git(projectPath, ['commit', '-m', subject, '--', ...chosen]);
  return { ok: true, files: chosen.length };
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
async function restoreFile(git, { projectPath, ref, path: filePath }) {
  try {
    await git(projectPath, ['cat-file', '-e', `${ref}:${filePath}`]);
  } catch {
    return {
      ok: false,
      missing: true,
      message: `That version doesn’t have this file — it was added later.`,
    };
  }
  await git(projectPath, ['checkout', ref, '--', filePath]);
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
 * `park` is passed in (it lives in main.js, over the stash) and is called
 * first whenever there is anything to lose. Without that, restoring over
 * uncommitted work would destroy it with no way back.
 */
async function restoreProject(git, { projectPath, ref, park }) {
  const dirty = (await git(projectPath, ['status', '--porcelain'])).stdout.trim().length > 0;
  let parked = false;
  if (dirty) {
    if (!park) {
      throw new Error(
        'There are unsaved changes here. Save them first — going back would write over them.'
      );
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
  await git(projectPath, ['read-tree', '-u', '--reset', ref]);
  return { ok: true, parked };
}

module.exports = { commit, restoreFile, restoreProject };

const fs = require('fs');
const path = require('path');
const { parseConflict, renderResolved } = require('./conflicts');

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
/** One side of a conflicted file, or null when that side deleted it. */
async function stage(git, projectPath, n, file) {
  try {
    return (await git(projectPath, ['show', `:${n}:${file}`])).stdout;
  } catch {
    return null;
  }
}

/**
 * Finish a merge that clashed, with the user's choice for each file.
 *
 * `choices` is `{ [path]: 'ours' | 'theirs' }`. The merge is run again here
 * rather than having been left open while the user decided, so the files never
 * sit on disk with conflict markers in them where the editor would try to
 * parse them as markup.
 *
 * What comes out is an ordinary merge commit with two parents — nothing about
 * it is special afterwards, and nothing about it needs undoing differently.
 */
async function resolveMerge(git, { projectPath, branch, choices }) {
  const into = await currentBranch(git, projectPath);
  try {
    // Same style as the trial merge above, or the markers this re-parses would
    // not be the ones the answers were given against.
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', branch]);
    // It went through cleanly this time: something changed underneath and
    // there was nothing left to choose between.
    return { ok: true, into, changed: true, resolved: 0 };
  } catch {
    /* expected — it clashes again, which is what the choices are for */
  }
  const left = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  try {
    for (const file of left) {
      const choice = choices?.[file];
      // An answer per disagreement — the file is rebuilt from git's own
      // markers with the chosen side of each. This is what makes it possible
      // to take part of a file from each branch.
      if (Array.isArray(choice)) {
        const parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
        fs.writeFileSync(path.join(projectPath, file), renderResolved(parts, choice));
      } else {
        // One answer for the whole file. Defaults to keeping what is on this
        // branch: a missing choice must never silently prefer the incoming
        // version over the user's own work.
        const side = choice === 'theirs' ? '--theirs' : '--ours';
        await git(projectPath, ['checkout', side, '--', file]);
      }
      await git(projectPath, ['add', '--', file]);
    }
    // Everything git reconciled by itself is already staged; this commits the
    // whole merge, the chosen files included.
    await git(projectPath, ['commit', '--no-edit']);
  } catch (err) {
    // Leave nothing half-merged behind — a tree stuck mid-merge is a state the
    // rest of the app has no way to draw.
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* already unwound */
    }
    throw new Error(
      String(err.stderr || err.message || '').trim() || `Could not finish merging "${branch}".`
    );
  }
  return { ok: true, into, changed: true, resolved: left.length };
}

async function mergeBranch(git, { projectPath, branch }) {
  const into = await currentBranch(git, projectPath);
  if (branch === into) {
    throw new Error(`"${branch}" is the branch you are on — there is nothing to merge into.`);
  }
  // No check for uncommitted work here.
  //
  // There used to be one, and it made the app refuse merges git would have
  // done: a merge only clashes with unsaved work when it touches the SAME
  // files, and most of the time it does not. Being told to commit before
  // merging — when the thing you have open is unrelated to the branch coming
  // in — is the same false obstacle that used to sit in front of switching
  // branches. Git decides; the refusal is handled below.
  const before = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  try {
    // --no-edit: a merge commit here must not open an editor nobody is sitting
    // at. Git still fast-forwards when it can.
    //
    // conflictStyle=diff3 writes the common ancestor into the markers as well
    // as the two sides. That third version is never offered as a choice — it
    // is what both branches started from — but it is what makes it possible to
    // tell which side actually changed each part, and so to default to the one
    // that did instead of asking about edits nobody disagrees over. Set with
    // -c so the user's own git config is not touched.
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', branch]);
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
    if (files.length) {
      // Both sides of every clash, read while the merge is still in progress —
      // stage 2 is this branch's version of the file, stage 3 is the incoming
      // one. This is what lets the app ask "which of these two?" instead of
      // sending someone to a terminal, which for most of the people this
      // editor is for is the same as refusing.
      const clashes = [];
      for (const file of files) {
        // The file as git left it, both versions in it and marked. Parsing
        // that rather than diffing the two sides here means the three-way
        // merge stays git's — it has the common ancestor, and this does not —
        // and each disagreement comes back separately, so a page whose heading
        // should come from one branch and whose footer should come from the
        // other can say so.
        let parts = null;
        try {
          parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
        } catch {
          // A binary file, or one side deleted it: there is no marked-up text
          // to read, and the choice is the whole file or nothing.
          parts = null;
        }
        clashes.push({
          path: file,
          ours: await stage(git, projectPath, 2, file),
          theirs: await stage(git, projectPath, 3, file),
          parts,
        });
      }
      // Unwound before returning. Conflict markers sitting in the files would
      // be read as markup by the editor a moment later, and the page would
      // come back broken with nothing to say why. So the tree goes back to
      // exactly how it was and the choice is made against the copies above;
      // applying it re-runs the merge (see resolveMerge), which keeps the
      // markers from ever existing while anyone is looking at the app.
      try {
        await git(projectPath, ['merge', '--abort']);
      } catch {
        /* already unwound */
      }
      return { ok: false, conflicted: true, from: into, branch, files: clashes };
    }
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* not a conflict, or already unwound — nothing to undo */
    }
    // Unsaved work in a file the merge needs to write. Git stops without
    // moving anything, so this is a question — park it, or commit it — rather
    // than an error, and it comes back shaped like the same question from a
    // branch switch so the UI can ask it the same way.
    const detail = `${err.stdout || ''}\n${err.stderr || err.message || ''}`;
    if (/would be overwritten|Please commit your changes|Your local changes/i.test(detail)) {
      const inTheWay = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning|hint|Updating|Merge with)/i.test(l) && !l.endsWith(':'));
      return { ok: false, dirty: true, from: into, branch, files: inTheWay };
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
async function deleteBranch(git, { projectPath, branch, force, allowTrunk }) {
  const here = await currentBranch(git, projectPath);
  if (branch === here) {
    throw new Error(`"${branch}" is the branch you are on — switch to another one first.`);
  }
  // Git will delete main as readily as anything else — `git branch -d main`
  // succeeds the moment main is merged into wherever you are standing, which
  // after any ordinary merge it is. The button for this is hidden, and it is
  // refused here as well: the branch everything comes back to should not go
  // because a caller somewhere forgot.
  // (Reaching here at all means another branch is checked out, so there is
  // always somewhere for the trunk's work to have gone — no need to check.)
  if (!allowTrunk && (branch === 'main' || branch === 'master')) {
    throw new Error(
      `"${branch}" is the branch everything comes back to. Deleting it would leave the project without its main line of work.`
    );
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

/**
 * Move to another branch.
 *
 * Plain `git switch`, tried before anything is asked. Git carries uncommitted
 * work across by itself whenever the files involved do not differ between the
 * two branches, which is nearly always — and asking "what shall I do with your
 * changes?" before trying turns the ordinary case into a dialog about a
 * problem that was not going to happen.
 *
 * When the work genuinely cannot come along, git refuses without moving HEAD
 * and names the files. That comes back as `{ ok: false, blocked: true, files }`
 * rather than an error, because it is a question for the user — leave the work
 * here, or commit it first — and a rejection crossing IPC arrives as a bare
 * string with no file list in it.
 *
 * `park` and `unpark` are passed in: they live in main.js, over the stash.
 */
async function switchBranch(git, { projectPath, branch, create, parkFirst, park, unpark }) {
  const from = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  let parked = false;
  // Only when asked. Creating a branch carries the work onto it, which is what
  // starting a branch from what is in front of you means.
  if (parkFirst && !create && park) parked = await park();
  // `switch`, not `checkout`: it does one thing, and it cannot silently detach
  // HEAD or restore a file over a mistyped branch name.
  try {
    await git(projectPath, create ? ['switch', '-c', branch] : ['switch', branch]);
  } catch (err) {
    // Put the work straight back rather than leaving it stashed behind a
    // branch change that never happened.
    if (parked && unpark) await unpark(from);
    const detail = String(err.stderr || err.message || '');
    if (/would be overwritten|Please commit your changes|overwritten by/i.test(detail)) {
      const files = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning|hint)/i.test(l) && !l.endsWith(':'));
      return { ok: false, blocked: true, from, branch, files };
    }
    throw new Error(detail.trim() || `Could not switch to "${branch}".`);
  }
  return { ok: true, from, parked };
}

module.exports = { mergeBranch, deleteBranch, switchBranch, resolveMerge };

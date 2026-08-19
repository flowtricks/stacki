// The checkout an old version is previewed from.
//
// Looking at what the site was like three commits ago means running it, and
// running it means having those files on disk somewhere. That somewhere is a
// git worktree: a second checkout of the same repository, at whatever commit
// is being looked at, with the real working tree left completely alone. The
// user's own files never move, which is what makes previewing safe enough to
// offer as a button.
//
// Three things about the design were established by trying them, and each one
// is the opposite of the obvious choice:
//
//   1. THE WORKTREE LIVES INSIDE THE PROJECT, at `.stacki/preview`.
//      The obvious home is the app's own data directory, out of the way. But a
//      worktree has no node_modules, and the fix for that — symlinking the
//      project's — breaks Astro: Node resolves the symlink to its real path
//      before resolving subpath exports, so `astro/app` is looked for relative
//      to the real node_modules while Vite's root is the worktree, and the
//      server dies with "Cannot find module 'astro/app'". Put the checkout
//      inside the project instead and there is no symlink at all: resolution
//      walks up from `.stacki/preview` and finds the project's real
//      node_modules the ordinary way.
//
//   2. IT IS HIDDEN FROM GIT THROUGH .git/info/exclude, NOT .gitignore.
//      .gitignore is the user's file, tracked and committed; writing to it
//      would show up as a change they did not make and would follow them into
//      a commit. info/exclude is local, untracked, and exactly for this.
//
//   3. ONE WORKTREE PER PROJECT, MOVED RATHER THAN MULTIPLIED.
//      A worktree per commit is a full copy of the project per commit. This
//      one is checked out again at each new ref, so the disk cost is one
//      checkout no matter how much history gets browsed.
//
// The dev server that runs against it is spawned by main.js, which owns ports
// and process handling. Everything here is the filesystem and git side, so it
// can be tested (test/preview-worktree.js) without booting Astro.

const fs = require('fs');
const path = require('path');

/** Where the preview checkout lives, and the directory git must not see. */
const PREVIEW_DIR = path.join('.stacki', 'preview');
const EXCLUDE_LINE = '.stacki/';

const previewPath = (projectPath) => path.join(projectPath, PREVIEW_DIR);

/**
 * Make git ignore `.stacki/` locally.
 *
 * Without this the preview checkout shows up as an untracked folder in the
 * user's own project — in the file picker, in the commit box, in every status
 * the app reads — and the first thing they would do is commit it.
 */
function ensureExcluded(projectPath) {
  // In a worktree, `.git` is a file pointing elsewhere; the exclude file we
  // want is always the main repository's.
  const gitDir = path.join(projectPath, '.git');
  let infoDir;
  try {
    const stat = fs.statSync(gitDir);
    infoDir = stat.isDirectory()
      ? path.join(gitDir, 'info')
      : // "gitdir: /path/to/.git/worktrees/x" — the common dir is two up.
        path.join(
          path.resolve(
            path.dirname(gitDir),
            fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim(),
            '..',
            '..'
          ),
          'info'
        );
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(infoDir, { recursive: true });
    const file = path.join(infoDir, 'exclude');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return true;
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      file,
      `${sep}# Stacki's preview checkout — not part of your project.\n${EXCLUDE_LINE}\n`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A checkout of `ref`, ready to run a dev server against.
 *
 * Created on first use and moved on every use after, so browsing history costs
 * one checkout rather than one per commit. Returns the path.
 */
async function ensureWorktree(git, { projectPath, ref }) {
  ensureExcluded(projectPath);
  const dir = previewPath(projectPath);

  // Is there already one, and does git still know about it? A folder left
  // behind by a crash is not a worktree, and `worktree add` onto it fails.
  const known = await isRegistered(git, projectPath, dir);
  if (!known && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    // Registered-but-missing is the other half of the same mess.
    try {
      await git(projectPath, ['worktree', 'prune']);
    } catch {
      /* nothing to prune */
    }
  }

  if (known) {
    // Moving an existing checkout: `--detach` keeps it off any branch, so it
    // can sit on the same commit a branch is on without git objecting that the
    // branch is checked out twice.
    await git(dir, ['checkout', '--detach', '--force', ref]);
    // A previous preview may have left build output behind; the checkout does
    // not remove untracked files and stale ones would be served.
    await git(dir, ['clean', '-qfd']);
    return dir;
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(projectPath, ['worktree', 'add', '--detach', '--force', dir, ref]);
  return dir;
}

async function isRegistered(git, projectPath, dir) {
  try {
    const { stdout } = await git(projectPath, ['worktree', 'list', '--porcelain']);
    const target = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
    return stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .some((p) => {
        try {
          return fs.existsSync(p) && fs.realpathSync(p) === target;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * Take the preview checkout away.
 *
 * Called when the project closes. Forced, because the checkout is disposable
 * by definition — nothing in it was ever the user's work, so there is nothing
 * in it to protect.
 */
async function removeWorktree(git, { projectPath }) {
  const dir = previewPath(projectPath);
  try {
    await git(projectPath, ['worktree', 'remove', '--force', dir]);
  } catch {
    // Already gone, or never registered. Either way the folder should not be
    // left behind.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // Leave `.stacki` itself only if something else put something in it.
    const parent = path.join(projectPath, '.stacki');
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    /* nothing to remove */
  }
  try {
    await git(projectPath, ['worktree', 'prune']);
  } catch {
    /* not a repo any more */
  }
  return { ok: true };
}

module.exports = { ensureWorktree, removeWorktree, ensureExcluded, previewPath, PREVIEW_DIR };

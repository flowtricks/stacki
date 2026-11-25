import { ensureExcluded } from '../lib/projectExclusions';
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
// The dev server that runs against it is spawned by handlers/previewHandlers.ts, which owns ports
// and process handling. Everything here is the filesystem and git side, so it
// can be tested (test/electron/preview/previewWorktree.test.js) without booting Astro.

import fs from 'fs';
import path from 'path';
import type { Git } from '../git/git';

/** Where the preview checkout lives, and the directory git must not see. */
const PREVIEW_DIRECTORY = path.join('.stacki', 'preview');

const previewPath = (projectPath: string): string => path.join(projectPath, PREVIEW_DIRECTORY);

/**
 * A checkout of `ref`, ready to run a dev server against.
 *
 * Created on first use and moved on every use after, so browsing history costs
 * one checkout rather than one per commit. Returns the path.
 */
async function ensureWorktree(git: Git, { projectPath, ref }: { readonly projectPath: string; readonly ref: string }): Promise<string> {
  ensureExcluded(projectPath);
  const directory = previewPath(projectPath);

  // Is there already one, and does git still know about it? A folder left
  // behind by a crash is not a worktree, and `worktree add` onto it fails.
  const known = await isRegistered(git, projectPath, directory);
  if (!known && fs.existsSync(directory)) {
    fs.rmSync(directory, { recursive: true, force: true });
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
    await git(directory, ['checkout', '--detach', '--force', ref]);
    // A previous preview may have left build output behind; the checkout does
    // not remove untracked files and stale ones would be served.
    await git(directory, ['clean', '-qfd']);
    return directory;
  }

  fs.mkdirSync(path.dirname(directory), { recursive: true });
  await git(projectPath, ['worktree', 'add', '--detach', '--force', directory, ref]);
  return directory;
}

async function isRegistered(git: Git, projectPath: string, directory: string): Promise<boolean> {
  try {
    const { stdout } = await git(projectPath, ['worktree', 'list', '--porcelain']);
    const target = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .some((worktreePath) => {
        try {
          return fs.existsSync(worktreePath) && fs.realpathSync(worktreePath) === target;
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
async function removeWorktree(git: Git, { projectPath }: { readonly projectPath: string }): Promise<{ ok: boolean }> {
  const directory = previewPath(projectPath);
  try {
    await git(projectPath, ['worktree', 'remove', '--force', directory]);
  } catch {
    // Already gone, or never registered. Either way the folder should not be
    // left behind.
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    // Leave `.stacki` itself only if something else put something in it.
    const parent = path.join(projectPath, '.stacki');
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
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

export { ensureWorktree, removeWorktree, ensureExcluded, previewPath, PREVIEW_DIRECTORY };

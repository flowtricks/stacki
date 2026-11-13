import fs from 'fs';
import path from 'path';

import { toArray } from '../../shared/core/record';
import type { MergeResolution, MergeTextResolution } from '../../shared/ipc/mergeResolution';
import { parseMergeResolution, mergeConflictSnapshot } from '../../shared/ipc/mergeResolution';
import { described, type MessageRef } from '../../shared/properties/i18n/messageRef';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { writeProjectText } from '../documents/documentWrites';
import { parseConflict, renderResolved } from './conflicts';
import type { ConflictPart } from './conflicts';
import { gitErrorDetail, gitErrorFull } from './git';
import type { Git } from './git';

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
// Kept out of the IPC handlers so the behaviour can be tested against a real repository
// (test/electron/git/gitBranches.test.js) rather than only through the app.
//
// `git` is passed in rather than imported: lib/nodeTools.ts runs git through a PATH it
// has had to repair for the packaged app, and the tests run it plainly.

/** Whether the working tree has anything uncommitted in it. — removed during
 * conversion: `isDirty` was defined here in HEAD but never called or exported.
 */
async function currentBranch(git: Git, projectPath: string): Promise<string | undefined> {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * What to throw when git refused: its own wording when it gave any (free-form text we do not translate), otherwise our sentence, whose
 * reference lets the renderer show it in the person's language.
 */
function gitFailure(detail: string, fallback: ReferencedError): Error {
  const words = detail.trim();
  return words.length > 0 ? new Error(words) : fallback;
}

export interface MergeClash {
  readonly path: string;
  readonly ours: string | undefined;
  readonly theirs: string | undefined;
  readonly parts: readonly ConflictPart[] | undefined;
}

export type MergeOutcome =
  | {
      readonly ok: true;
      readonly into: string | undefined;
      readonly changed: boolean;
      readonly resolved?: number;
    }
  | {
      readonly ok: false;
      readonly conflicted: true;
      readonly from: string | undefined;
      readonly branch: string;
      readonly files: readonly MergeClash[];
    }
  | {
      readonly ok: false;
      readonly dirty: true;
      readonly from: string | undefined;
      readonly branch: string;
      readonly files: readonly string[];
    };

/** One side of a conflicted file, or undefined when that side deleted it. */
async function stage(git: Git, projectPath: string, stageNumber: number, file: string): Promise<string | undefined> {
  try {
    return (await git(projectPath, ['show', `:${stageNumber}:${file}`])).stdout;
  } catch {
    return undefined;
  }
}

/**
 * Finish a merge that clashed, with the user's choice for each file.
 *
 * Choices select whole files, individual changes, or exact reviewed text.
 * The merge is run again here
 * rather than having been left open while the user decided, so the files never
 * sit on disk with conflict markers in them where the editor would try to
 * parse them as markup.
 *
 * What comes out is an ordinary merge commit with two parents — nothing about
 * it is special afterwards, and nothing about it needs undoing differently.
 */
async function resolveMerge(
  git: Git,
  {
    projectPath,
    branch,
    choices,
  }: {
    readonly projectPath: string;
    readonly branch: string;
    readonly choices?: Record<string, unknown>;
  },
): Promise<MergeOutcome> {
  const into = await currentBranch(git, projectPath);
  const resolutions = Object.fromEntries(
    Object.entries(choices ?? {}).map(([file, choice]): readonly [string, MergeResolution] => [file, parseMergeResolution(choice)]),
  );
  const edited = Object.values(resolutions).filter((choice) => typeof choice === 'object' && 'kind' in choice);
  const clean = await resolveMergeStart(git, { projectPath, branch, into, edited });
  if (clean) {
    if (edited.length > 0) {
      await git(projectPath, ['merge', '--abort']);
      throw new ReferencedError('git.error.mergeChangedSinceReview');
    }
    return { ok: true, into, changed: true, resolved: 0 };
  }
  const left = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  try {
    if (edited.length > 0 && (left.length !== Object.keys(resolutions).length || left.some((file) => resolutions[file] === undefined))) {
      throw new ReferencedError('git.error.mergeFilesChanged');
    }
    for (const file of left) {
      const choice = resolutions[file] ?? 'ours';
      await resolveMergeFile(git, projectPath, file, choice);
      await git(projectPath, ['add', '--', file]);
    }
    // Everything git reconciled by itself is already staged; this commits the
    // whole merge, the chosen files included.
    await git(projectPath, ['commit', '--no-edit']);
  } catch (error: unknown) {
    // Leave nothing half-merged behind — a tree stuck mid-merge is a state the
    // rest of the app has no way to draw.
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* already unwound */
    }
    throw gitFailure(gitErrorDetail(error), new ReferencedError('git.error.mergeFinishFailed', { branch }));
  }
  return { ok: true, into, changed: true, resolved: left.length };
}

async function resolveMergeStart(
  git: Git,
  {
    projectPath,
    branch,
    into,
    edited,
  }: {
    readonly projectPath: string;
    readonly branch: string;
    readonly into: string | undefined;
    readonly edited: readonly MergeTextResolution[];
  },
): Promise<boolean> {
  for (const choice of edited) {
    if (into !== choice.expectedBranch) {
      throw new ReferencedError('git.error.mergeBranchChanged');
    }
  }
  let clean = false;
  try {
    const prepare = edited.length > 0 ? ['--no-commit', '--no-ff'] : [];
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', ...prepare, branch]);
    clean = true;
  } catch {
    /* Expected: the merge conflicts again and must be resolved below. */
  }
  return clean;
}

// Keep file reconstruction separate from merge orchestration so every write
// follows validation, and an error always unwinds the prepared merge above.
async function resolveMergeFile(git: Git, projectPath: string, file: string, choice: MergeResolution): Promise<void> {
  // An answer per disagreement — the file is rebuilt from git's own
  // markers with the chosen side of each. This is what makes it possible
  // to take part of a file from each branch.
  const perHunk = toArray(choice);
  if (typeof choice === 'object' && 'kind' in choice) {
    const parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
    if (mergeConflictSnapshot(parts) !== choice.expected) {
      throw new ReferencedError('git.error.mergeFileChanged');
    }
    writeProjectText(path.join(projectPath, file), choice.text);
  } else if (perHunk) {
    const parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
    writeProjectText(path.join(projectPath, file), renderResolved(parts, perHunk));
  } else {
    // One answer for the whole file. Defaults to keeping what is on this
    // branch: a missing choice must never silently prefer the incoming
    // version over the user's own work.
    const side = choice === 'theirs' ? '--theirs' : '--ours';
    await git(projectPath, ['checkout', side, '--', file]);
  }
}

/**
 * Fold `branch` into the branch currently checked out.
 *
 * Named for the argument git takes, so "merge home-test" means what
 * `git merge home-test` means — the direction is never something to work out
 * from where a button sits.
 *
 * `changed` is false for a merge that moved nothing: reporting "merged" there
 * would suggest work arrived that was already present.
 */
async function mergeBranch(git: Git, { projectPath, branch }: { readonly projectPath: string; readonly branch: string }): Promise<MergeOutcome> {
  const into = await currentBranch(git, projectPath);
  if (branch === into) {
    throw new ReferencedError('git.error.mergeSelf', { branch });
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
  } catch (error: unknown) {
    // Which files git could not reconcile — asked of git rather than scraped
    // out of its prose, which comes in several shapes (content, modify/delete,
    // add/add) and on STDOUT, not stderr. Read before the abort, which is what
    // clears it.
    let files: string[] = [];
    try {
      files = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
        .split('\n')
        .map((line) => line.trim())
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
      const clashes: MergeClash[] = [];
      for (const file of files) {
        // The file as git left it, both versions in it and marked. Parsing
        // that rather than diffing the two sides here means the three-way
        // merge stays git's — it has the common ancestor, and this does not —
        // and each disagreement comes back separately, so a page whose heading
        // should come from one branch and whose footer should come from the
        // other can say so.
        let parts: readonly ConflictPart[] | undefined = undefined;
        try {
          parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
        } catch {
          // A binary file, or one side deleted it: there is no marked-up text
          // to read, and the choice is the whole file or nothing.
          parts = undefined;
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
    const detail = gitErrorFull(error);
    if (/would be overwritten|Please commit your changes|Your local changes/i.test(detail)) {
      const inTheWay = detail
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(error|Please|Aborting|warning|hint|Updating|Merge with)/i.test(line) && !line.endsWith(':'));
      return { ok: false, dirty: true, from: into, branch, files: inTheWay };
    }
    throw gitFailure(gitErrorDetail(error), new ReferencedError('git.error.mergeFailed', { branch, into: into ?? 'HEAD' }));
  }
  const after = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, into, changed: after !== before };
}

export type DeleteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly unmerged: true; readonly message: string; readonly messageRef?: MessageRef | undefined };

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
async function deleteBranch(
  git: Git,
  {
    projectPath,
    branch,
    force,
    allowTrunk,
  }: {
    readonly projectPath: string;
    readonly branch: string;
    readonly force?: boolean;
    readonly allowTrunk?: boolean;
  },
): Promise<DeleteOutcome> {
  const here = await currentBranch(git, projectPath);
  if (branch === here) {
    throw new ReferencedError('git.error.deleteSelf', { branch });
  }
  // Git will delete main as readily as anything else — `git branch -d main`
  // succeeds the moment main is merged into wherever you are standing, which
  // after any ordinary merge it is. The button for this is hidden, and it is
  // refused here as well: the branch everything comes back to should not go
  // because a caller somewhere forgot.
  // (Reaching here at all means another branch is checked out, so there is
  // always somewhere for the trunk's work to have gone — no need to check.)
  if (!allowTrunk && (branch === 'main' || branch === 'master')) {
    throw new ReferencedError('git.error.deleteTrunk', { branch });
  }
  try {
    await git(projectPath, ['branch', force ? '-D' : '-d', branch]);
  } catch (error: unknown) {
    const detail = gitErrorDetail(error);
    if (/not fully merged/i.test(detail)) {
      return {
        ok: false,
        unmerged: true,
        ...described('git.action.delete.unmerged', { branch }),
      };
    }
    // Checked out somewhere else — another worktree of this same repository.
    // Not the branch you are on, so the check above let it through, and git's
    // own wording leads with a path nobody asked about.
    const worktree = detail.match(/used by worktree at '([^']+)'/);
    const where = worktree?.[1];
    if (where !== undefined) {
      throw new ReferencedError('git.error.deleteWorktree', { branch, path: where });
    }
    throw gitFailure(detail, new ReferencedError('git.error.deleteFailed', { branch }));
  }
  return { ok: true };
}

export type SwitchOutcome =
  | { readonly ok: true; readonly from: string; readonly parked: boolean }
  | {
      readonly ok: false;
      readonly blocked: true;
      readonly from: string;
      readonly branch: string;
      readonly files: readonly string[];
    };

/**
 * Move to another branch.
 *
 * Existing branches have separate unfinished work. Park before switching even
 * when Git could carry edits across, so previews do not contain another branch's
 * edits. Creating a branch intentionally carries the current work onto it.
 * The caller restores the destination's own parked work after a successful switch.
 */
async function switchBranch(
  git: Git,
  {
    projectPath,
    branch,
    create,
    park,
    unpark,
  }: {
    readonly projectPath: string;
    readonly branch: string;
    readonly create?: boolean;
    readonly park: (branch: string) => Promise<boolean>;
    readonly unpark: (branch: string) => Promise<unknown>;
  },
): Promise<SwitchOutcome> {
  const from = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  let parked = false;
  if (!create && from !== branch) {
    parked = await park(from);
  }
  // `switch`, not `checkout`: it does one thing, and it cannot silently detach
  // HEAD or restore a file over a mistyped branch name.
  try {
    await git(projectPath, create ? ['switch', '-c', branch] : ['switch', branch]);
  } catch (error: unknown) {
    // Put the work straight back rather than leaving it stashed behind a
    // branch change that never happened.
    if (parked) {
      await unpark(from);
    }
    const detail = gitErrorDetail(error);
    if (/would be overwritten|Please commit your changes|overwritten by/i.test(detail)) {
      const files = detail
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(error|Please|Aborting|warning|hint)/i.test(line) && !line.endsWith(':'));
      return { ok: false, blocked: true, from, branch, files };
    }
    throw gitFailure(detail, new ReferencedError('git.error.switchFailed', { branch }));
  }
  return { ok: true, from, parked };
}

/** A branch name longer than this is not one git would have made; the answer falls back to the trunk. */
const DEFAULT_BRANCH_CHARS_MAX = 255;

/**
 * The branch this project publishes from: the remote's own default (`origin/HEAD`, so a repository whose default is `develop`
 * is not told it is on the wrong branch), else the trunk (main or master the caller found). Branch names are data: they go to git
 * as argv entries, never into a shell string. Undefined when neither is known, so the renderer stays quiet rather than guessing.
 */
async function readDefaultBranch(git: Git, projectPath: string, trunk: string | undefined): Promise<string | undefined> {
  try {
    const named = (await git(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
    const prefix = 'origin/';
    if (named.startsWith(prefix) && named.length > prefix.length && named.length <= DEFAULT_BRANCH_CHARS_MAX) {
      return named.slice(prefix.length);
    }
  } catch {
    /* No remote, or origin/HEAD was never set: fall back to the trunk below. */
  }
  return trunk;
}

export { mergeBranch, deleteBranch, switchBranch, resolveMerge, readDefaultBranch };

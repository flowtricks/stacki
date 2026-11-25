---
title: Git and GitHub
description: The Git panel — commits, per-file staging, branches, merges, history and the work Stacki sets aside for you.
group: shipping
order: 1
keywords:
  [
    "git",
    "commit",
    "stage",
    "push",
    "pull",
    "branch",
    "merge",
    "conflict",
    "github",
    "publish",
    "clone",
    "stash",
    "history",
  ]
---

Version control lives in the **Git** panel (<kbd>⌥</kbd><kbd>H</kbd>), under its
own icon on the left rail. There is no branch chip in the title bar; the title
bar holds the terminal and preview buttons, Settings, and the `Publish` split
button.

A project that is not a repository yet gets one button, `Initialize Git`, which
runs `git init -b main`. Worth knowing: Stacki cannot tell "this folder is not a
repository" apart from "this machine has no `git`" — both come back the same
way — so on a machine without git you will be offered `Initialize Git` and the
init will fail instead.

## Committing

The commit controls sit under the branch list, headed `Commit to` and then the
current branch. Type into `Commit message` and press <kbd>Enter</kbd>, or use
the button, which names what it is about to do: `Nothing to commit`,
`Commit all changes`, or `Commit 3 files` once you have picked some. An empty
message commits as `Update from Stacki`.

Picking files is real staging, not a filter: the file picker beside the button
lists everything that has changed, and only the paths you tick go into the
commit. An explicit selection stays explicit — files that change while the
picker is open are not quietly added to it.

## Pulling

With a remote configured, a `Pull from GitHub` button sits at the top of the
panel. It is disabled with `No changes to pull` until there is something to
take; Stacki checks in the background and the button's tooltip says what it
found — `2 commits to pull`, `Checking GitHub for incoming changes…`, or that
the check failed and is being retried.

A pull that would land on top of your own uncommitted edits to the same files
stops and says so rather than proceeding. A pull that conflicts opens the same
review as a merge, below.

## Pushing and publishing

Pushing is not in this panel. `Push to GitHub` is an option on the title bar's
`Publish` split button, which also carries `Deploy to hosting` for a configured
provider. Pushing runs no build and no publish hooks; deploying runs both. The
option's sub-line is the count — `3 commits to push`, or `No changes to push`,
in which case it is disabled.

Publishing a project that has no remote yet is a dialog of its own, also reached
from `Publish`. Choose `Create a new repository` — with a name and an optional
`Private repository` — or `Use an existing repository` from the list of ones you
can push to. Either way it commits anything outstanding first, then creates or
connects the repository and pushes.

That path needs the [GitHub CLI](https://cli.github.com): the dialog checks for
it and says `GitHub CLI (gh) isn't installed` or
`GitHub CLI isn't signed in. Run gh auth login in a terminal, then reopen this
dialog.` Ordinary commits, pulls, branches and merges do not need `gh` at all —
they use whatever git authentication you already have, SSH included.

Cloning is on the start screen instead, as `Open from GitHub` beside
`Open from folder`. It asks for a folder and downloads a fresh local copy with
its git history. It also goes through `gh`.

## Branches

The `Branches` section lists every local branch with a count. Click a row to
switch to it. Each row that is not the current branch carries a merge button
(`Merge feature into main`) and, unless it is the trunk, a delete button.
`New branch` opens a name field; creating a branch takes your uncommitted work
onto it, which is what starting a branch from what is in front of you means.

Deleting asks once, and asks a second, differently-worded time if git refuses
because the branch holds commits found nowhere else. A branch with work set
aside on it says so in the first dialog: the work stays where it is, but nothing
will bring it back once the branch is gone.

## Switching branches with work in progress

Git will not switch over changes it would have to overwrite, and the usual
advice — commit them first — asks for a commit that only exists to make git
cooperate.

When a switch would be blocked, Stacki asks, with no default action, because
taking changes with you and leaving them behind are both reasonable and picking
one silently is how edits end up on the wrong branch:

- **Leave them on `<branch>`** sets the work aside against the branch it was
  written on. Nothing is committed.
- **Commit first** commits to the branch you are on and then switches.

Work left behind comes back on its own the next time that branch is opened, and
the branch's row says `Saved changes` in the meantime so where you left it is
visible rather than something to remember.

Underneath it is a tagged stash, `stacki:park:<branch>`, and the tag is what
makes it safe: only a stash Stacki wrote is ever restored, so a `git stash` you
made by hand is left alone. The edges each have their own message:

- A switch that fails puts the work straight back, rather than leaving it
  stashed behind a change that never happened.
- A destination with its own local changes refuses, and says the work is still
  parked.
- Work that no longer applies because the branch moved under it stays parked and
  tells you how to get it by hand. A stash that cannot apply would leave
  conflict markers in files Stacki parses a moment later — fair at a terminal,
  bad here.

A merge that finds unsaved work in its way offers the same two steps as one
choice, `Set it aside and merge`, and puts the work back afterwards either way.

## Merging

Merging names both branches in the confirmation, because the direction is the
whole decision. It offers to delete the merged branch afterwards, ticked, since
a folded-in branch is usually finished — except when you are merging the trunk
into your branch to catch up, where deleting it would destroy the project's main
line as a side effect of housekeeping.

Stacki merges with git's own three-way machinery, and reads the common ancestor
to work out which side actually changed each region, so it can default to the
one that did. But you are only ever asked about two sides: the ancestor "is
never offered as a choice — it is what both branches started from". Calling it a
three-way merge tool would overstate what the dialog does.

The review is headed `Review merge`, with the subtitle
`Independent changes are combined. Review highlights or edit the final code.` A
list of `Changed files` on the left, the `Final code` on the right, and per
change: `Keep <your branch>`, `Keep <incoming branch>`, and either
`Combine edits` or `Keep both blocks` where that is possible. You can also edit
the result directly, which marks it `Your edits`.

While you are deciding, your working tree holds no conflict markers. Stacki
reads both sides out of git's index, aborts the merge, and re-runs it with your
answers once you confirm — because markers sitting in a file would be parsed as
markup by the editor.

## History

The `Version history` section below the controls is the commit log, with a
lane per branch and a filter for `All branches` or just the current one. Each
commit shows how many files it added, deleted and updated, and opens them for a
per-file diff.

Two things can be done from a commit:

- **Preview** puts the canvas on that version of the site. The button becomes
  `Back to now`, and so does the title bar's preview button; <kbd>Esc</kbd> and
  <kbd>⌥</kbd><kbd>P</kbd> also return you to the present.
- **Restore project to this commit…** brings the whole project back, parking
  your current tree first. Restoring a single file from the commit's file list
  lands it as an ordinary uncommitted change, so nothing is thrown away
  silently and the result is a diff you can read before committing it.

An empty repository says so: `Nothing saved yet. Once you save your first
version it shows up here, and you can come back to it whenever you like.`

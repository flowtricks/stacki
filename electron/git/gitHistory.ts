// Reading history.
//
// Everything else this app does to git changes something. This is the half
// that only looks: the log, what a commit touched, what is changed right now,
// and which worktrees exist. Nothing here writes.
//
// It is a separate module from gitBranches.js for the same reason that one
// exists — so it can be tested against real repositories (test/electron/git/gitHistory.test.js)
// rather than only through the app — and it takes the `git` runner as its
// first argument for the same reason: lib/nodeTools.ts runs git through a PATH it has
// had to repair for the packaged app, and the tests run it plainly.
//
// The traps here are all in git's output rather than in its behaviour, and
// each one is the kind that produces a plausible wrong answer rather than an
// error:
//
//   - `--name-status` on a MERGE commit prints NOTHING. Not an error,
//     not a diff — an empty list, because a diff against several parents is
//     ambiguous and git declines to pick. A history panel reading it straight
//     would draw every merge as a commit that changed no files.
//   - A repository with no commits yet makes `git log` exit 128. That is a new
//     project, not a failure, and it has to read as an empty history.
//   - A rename is one path in the working tree and two in a commit, so the
//     record for it has a field the others do not.
//
// Paths come back in git's own terms. Turning `src/pages/index.astro` into
// "Home" needs the project's routing, which lives in project/ — so that
// translation happens at the IPC edge, and this module stays about git.

import { gitErrorDetail } from './git';
import type { Git } from './git';

// Field and record separators: git will happily put anything in a subject
// line, including newlines and tabs, so the format is delimited by bytes a
// commit message cannot contain.
const US = '\x1f'; // between fields
const RS = '\x1e'; // before each commit
// The separator leads the record rather than trailing it, so that the file
// list `--name-status` prints after a commit belongs to the record it follows.
const LOG_FORMAT = RS + ['%H', '%h', '%an', '%ae', '%aI', '%s', '%P', '%D'].join(US);

// One flag set for merge commits, ordinary commits and the root commit alike:
//
//   --diff-merges=first-parent  a merge is shown as the diff against the branch
//                      it was merged INTO, which is the change it made to where
//                      you are standing. Without it, merges come back empty.
//   -M                 detect renames, so a moved page reads as a move rather
//                      than as one file deleted and an unrelated one added.
//
// NOT `-m --first-parent`, which gives the same diffs and looks equivalent.
// On `git log`, `--first-parent` also changes which commits are LISTED: it
// stops following the second parent of a merge, so every commit made on a
// branch disappears from the history the moment that branch is merged. The
// timeline would quietly lose the work it exists to show, with the merge still
// sitting there as if nothing had come with it.
//
// `--diff-merges` only ever affects the diff, which is all that was wanted.
const DIFF_FLAGS = ['--diff-merges=first-parent', '-M'];

/** True when the failure is "this repository has no commits yet". */
const isEmptyRepo = (error: unknown): boolean =>
  /does not have any commits yet|bad default revision|unknown revision/i.test(
    gitErrorDetail(error),
  );

export interface FileChange {
  readonly status: string;
  readonly path: string;
  readonly from?: string;
}

export interface CommitInfo {
  readonly files: FileChange[] | undefined;
  readonly hash: string | undefined;
  readonly shortHash: string | undefined;
  readonly author: string | undefined;
  readonly email: string | undefined;
  readonly when: string | undefined; // ISO 8601 with offset; the panel decides how to say it
  readonly subject: string | undefined;
  readonly parents: readonly string[];
  readonly refs: readonly string[];
  readonly isMerge: boolean;
}

/**
 * Commits in child-before-parent order, across branches unless a ref is selected.
 *
 * `limit`/`skip` page it — the panel scrolls rather than loading a history
 * that can be tens of thousands of commits long.
 */
async function log(
  git: Git,
  {
    projectPath,
    ref,
    limit = 50,
    skip = 0,
    withFiles = false,
  }: {
    readonly projectPath: string;
    readonly ref?: string;
    readonly limit?: number;
    readonly skip?: number;
    readonly withFiles?: boolean;
  },
): Promise<{ commits: CommitInfo[]; atEnd: boolean }> {
  // Topological order keeps every parent below its children even when clocks
  // disagree. Exclude stashes because their synthetic commits are not history.
  const args = [
    'log',
    '--topo-order',
    '--decorate=short',
    `--format=${LOG_FORMAT}`,
    `-n${limit}`,
    `--skip=${skip}`,
  ];
  // One call for the whole page, files included. The alternative — a `git
  // show` per commit to find out what it touched — is fifty processes to draw
  // one screen, and the panel needs the files to say "you changed Home"
  // rather than just the subject line.
  if (withFiles) {
    args.push('--name-status', ...DIFF_FLAGS);
  }
  if (ref) {
    args.push(ref);
  } else {
    args.push('--exclude=refs/stash', '--all');
  }
  let stdout: string;
  try {
    ({ stdout } = await git(projectPath, args));
  } catch (error: unknown) {
    // A project that has just been initialised has a branch and no commits.
    // That is an empty history, not a broken one.
    if (isEmptyRepo(error)) {
      return { commits: [], atEnd: true };
    }
    throw error;
  }
  const commits: CommitInfo[] = stdout
    .split(RS)
    .filter((rec) => rec.trim())
    .map((rec) => {
      // The first line is the format; anything after it is the file list this
      // commit touched, when one was asked for.
      const nl = rec.indexOf('\n');
      const head = nl === -1 ? rec : rec.slice(0, nl);
      const rest = nl === -1 ? '' : rec.slice(nl + 1);
      const [hash, shortHash, author, email, when, subject, parents, refs] = head.split(US);
      const parentList = parents ? parents.split(' ').filter(Boolean) : [];
      return {
        files: withFiles ? parseNameStatus(rest) : undefined,
        hash,
        shortHash,
        author,
        email,
        when,
        subject,
        parents: parentList,
        // "HEAD -> main, origin/main, tag: v1" — what to badge the row with.
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        isMerge: parentList.length > 1,
      };
    });
  // `atEnd` is inferred from a short page, which costs nothing and is right
  // except when the history length is an exact multiple of the page size (one
  // extra empty fetch).
  return { commits, atEnd: commits.length < limit };
}

function parseNameStatus(stdout: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const code = parts[0];
    if (code === undefined) {
      continue;
    }
    // A rename or copy is "R100\told\tnew" — a similarity score on the code
    // and two paths. Everything else is one code and one path.
    const from = parts[1];
    const to = parts[2];
    if (/^[RC]/.test(code) && parts.length >= 3 && from !== undefined && to !== undefined) {
      files.push({ status: code.charAt(0), path: to, from });
    } else if (parts.length >= 2 && from !== undefined) {
      files.push({ status: code.charAt(0), path: from });
    }
  }
  return files;
}

export interface StatusFile {
  readonly path: string;
  readonly from: string | undefined; // always present; undefined unless a staged rename
  readonly status: string;
  readonly staged: boolean;
  readonly untracked: boolean;
}

/**
 * Everything changed right now, for the file picker — the whole list, with
 * what happened to each file. `git:info` keeps its own capped summary for the
 * chip; this is the one that has to be complete, because a file missing from
 * it is a file that silently cannot be committed.
 */
async function status(
  git: Git,
  { projectPath }: { readonly projectPath: string },
): Promise<StatusFile[]> {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  const files: StatusFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    // Porcelain v1 is "XY path": two status columns, a space, then the path.
    // Not trimmed before slicing — the first column is a space for changes
    // that are only in the working tree, and trimming loses that distinction.
    const code = line.slice(0, 2);
    let entryPath = line.slice(3);
    let from: string | undefined;
    // "R  old -> new" — staged renames carry both names.
    const arrow = entryPath.lastIndexOf(' -> ');
    if (arrow !== -1) {
      from = unquote(entryPath.slice(0, arrow));
      entryPath = entryPath.slice(arrow + 4);
    }
    files.push({
      path: unquote(entryPath),
      from,
      // The letter to show. `??` is git's "untracked", which to anyone who did
      // not choose that spelling is simply a new file.
      status: code === '??' ? 'A' : code.trim().charAt(0) || 'M',
      staged: code.charAt(0) !== ' ' && code !== '??',
      untracked: code === '??',
    });
  }
  return files;
}

// Git quotes paths containing non-ASCII or control characters. Only the outer
// quotes are undone here — a path that needed the full C-style unescaping is
// rare enough that showing it slightly wrong beats getting the common case
// wrong by hand-rolling an unescaper.
const unquote = (text: string): string =>
  text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;

export interface ProjectFile {
  readonly path: string;
  readonly status: string | undefined;
  readonly staged: boolean;
}

/**
 * Every file in the project, with what has happened to each.
 *
 * `git ls-files --cached --others --exclude-standard` is the right list and a
 * walk of the directory is not: it is what git tracks plus what it would track
 * if asked, and nothing that is ignored. So node_modules, dist and .stacki are
 * absent for free, without this code having to know what any of them are, and
 * a project with its own unusual .gitignore is respected rather than
 * second-guessed.
 *
 * Status comes from the same porcelain the file picker reads, so a file cannot
 * appear as changed in one place and clean in another.
 */
async function allFiles(
  git: Git,
  { projectPath }: { readonly projectPath: string },
): Promise<ProjectFile[]> {
  const { stdout } = await git(projectPath, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  const changed = new Map((await status(git, { projectPath })).map((entry) => [entry.path, entry]));
  const paths = [
    ...new Set(
      stdout
        .split('\n')
        .map((line) => unquote(line.trim()))
        .filter(Boolean),
    ),
  ];
  // A deleted file is gone from the working tree, so ls-files still lists it
  // from the index — but a file deleted and staged is not listed at all, and
  // it is exactly the one somebody may want to find and put back.
  for (const [changedPath] of changed) {
    if (!paths.includes(changedPath)) {
      paths.push(changedPath);
    }
  }
  return paths.sort().map((filePath) => {
    const change = changed.get(filePath);
    return {
      path: filePath,
      status: change ? change.status : undefined,
      staged: change ? change.staged : false,
    };
  });
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly bare: boolean;
}

/** Every worktree of this repository, the main one first. */
async function worktrees(
  git: Git,
  { projectPath }: { readonly projectPath: string },
): Promise<WorktreeInfo[]> {
  const { stdout } = await git(projectPath, ['worktree', 'list', '--porcelain']);
  // Blank-line-separated records of "key value" lines. `detached` and `bare`
  // are bare keys with no value.
  return stdout
    .split('\n\n')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const out: {
        path: string | undefined;
        head: string | undefined;
        branch: string | undefined;
        detached: boolean;
        bare: boolean;
      } = {
        path: undefined,
        head: undefined,
        branch: undefined,
        detached: false,
        bare: false,
      };
      for (const line of rec.split('\n')) {
        const sp = line.indexOf(' ');
        const key = sp === -1 ? line : line.slice(0, sp);
        const value = sp === -1 ? '' : line.slice(sp + 1);
        if (key === 'worktree') {
          out.path = value;
        } else if (key === 'HEAD') {
          out.head = value;
        } else if (key === 'branch') {
          out.branch = value.replace(/^refs\/heads\//, '');
        } else if (key === 'detached') {
          out.detached = true;
        } else if (key === 'bare') {
          out.bare = true;
        }
      }
      return out;
    })
    .filter((worktree): worktree is WorktreeInfo => worktree.path !== undefined);
}

// --- Saying what a file is -------------------------------------------------
//
// "src/pages/index.astro" is not an answer to "what changed". The person
// reading this panel made a home page, and that is the word for it. Every path
// git reports goes through here on its way to the panel.
//
// Pure, and on the repo-relative path alone: an Astro project's shape is a
// convention (src/pages, src/components, src/layouts) rather than something
// this has to go to disk to learn, which is what keeps it testable.

const TITLE = (seg: string): string =>
  seg.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase());

export type FileKind =
  | 'page'
  | 'component'
  | 'layout'
  | 'content'
  | 'asset'
  | 'style'
  | 'config'
  | 'script'
  | 'doc'
  | 'file';

export interface FileDescription {
  readonly path: string;
  readonly kind: FileKind;
  readonly label: string;
}

/**
 * `{ path, kind, label }` for one repo-relative path.
 *
 * `kind` is for the icon, `label` is what the row says. A path this knows
 * nothing about keeps its own name rather than being forced into a category —
 * a wrong label is worse than a plain one.
 */
function describeFile(relPath: unknown): FileDescription {
  const posixPath = String(relPath || '').replace(/\\/g, '/');
  const base = posixPath.split('/').pop() || posixPath;

  const page = posixPath.match(/^src\/pages\/(.+)\.(astro|mdx?)$/i);
  const pageRoute = page?.[1];
  if (pageRoute !== undefined) {
    let route = pageRoute;
    if (route === 'index') {
      return { path: posixPath, kind: 'page', label: 'Home' };
    }
    // "about/index" is the same page as "about" — the folder is the route.
    if (route.endsWith('/index')) {
      route = route.slice(0, -'/index'.length);
    }
    return { path: posixPath, kind: 'page', label: route.split('/').map(TITLE).join(' / ') };
  }
  const comp = posixPath.match(/^src\/components\/(.+)\.(astro|jsx?|tsx?|vue|svelte)$/i);
  const compName = comp?.[1];
  if (compName !== undefined) {
    return { path: posixPath, kind: 'component', label: compName.split('/').pop() ?? compName };
  }

  const layout = posixPath.match(/^src\/layouts\/(.+)\.(astro|jsx?|tsx?)$/i);
  const layoutName = layout?.[1];
  if (layoutName !== undefined) {
    return { path: posixPath, kind: 'layout', label: layoutName.split('/').pop() ?? layoutName };
  }

  if (/^src\/content\//i.test(posixPath)) {
    return { path: posixPath, kind: 'content', label: base };
  }
  if (/^public\//i.test(posixPath)) {
    return { path: posixPath, kind: 'asset', label: base };
  }
  if (/\.(css|scss|sass|less)$/i.test(posixPath)) {
    return { path: posixPath, kind: 'style', label: base };
  }
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i.test(posixPath)) {
    return { path: posixPath, kind: 'asset', label: base };
  }
  // Config and lockfiles are the ones a designer should not be asked to read.
  if (
    /^(package(-lock)?\.json|astro\.config\.[a-z]+|tsconfig\.json|\.gitignore)$/i.test(posixPath)
  ) {
    return { path: posixPath, kind: 'config', label: base };
  }
  // Script and prose get named rather than falling into the catch-all. Both
  // are things people change on purpose and go looking for by type — a
  // stylesheet is offered as a stylesheet, and a script should be too.
  if (/\.(m|c)?[jt]sx?$/i.test(posixPath)) {
    return { path: posixPath, kind: 'script', label: base };
  }
  if (/\.mdx?$/i.test(posixPath)) {
    return { path: posixPath, kind: 'doc', label: base };
  }
  // Anything genuinely unrecognised keeps its own path. Guessing a category
  // for it would be worse than saying where it is.
  return { path: posixPath, kind: 'file', label: posixPath };
}

/** Every file in a list, described. Renames keep where they came from. */
const describeFiles = <T extends { readonly path: string; readonly from?: string | undefined }>(
  files: readonly T[] | undefined,
): (T & FileDescription & { readonly from: string | undefined })[] =>
  (files ?? []).map((file) => ({ ...file, ...describeFile(file.path), from: file.from }));

export { allFiles, log, status, worktrees, parseNameStatus, describeFile, describeFiles };

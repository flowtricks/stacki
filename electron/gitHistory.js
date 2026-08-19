// Reading history.
//
// Everything else this app does to git changes something. This is the half
// that only looks: the log, what a commit touched, what is changed right now,
// a file as it was, and which worktrees exist. Nothing here writes.
//
// It is a separate module from gitBranches.js for the same reason that one
// exists — so it can be tested against real repositories (test/git-history.js)
// rather than only through the app — and it takes the `git` runner as its
// first argument for the same reason: main.js runs git through a PATH it has
// had to repair for the packaged app, and the tests run it plainly.
//
// The traps here are all in git's output rather than in its behaviour, and
// each one is the kind that produces a plausible wrong answer rather than an
// error:
//
//   - `git show --name-status` on a MERGE commit prints NOTHING. Not an error,
//     not a diff — an empty list, because a diff against several parents is
//     ambiguous and git declines to pick. A history panel reading it straight
//     would draw every merge as a commit that changed no files.
//   - A repository with no commits yet makes `git log` exit 128. That is a new
//     project, not a failure, and it has to read as an empty history.
//   - A rename is one path in the working tree and two in a commit, so the
//     record for it has a field the others do not.
//
// Paths come back in git's own terms. Turning `src/pages/index.astro` into
// "Home" needs the project's routing, which lives in main.js — so that
// translation happens at the IPC edge, and this module stays about git.

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
const isEmptyRepo = (err) =>
  /does not have any commits yet|bad default revision|unknown revision/i.test(
    String(err.stderr || err.message || '')
  );

/**
 * Commits, newest first.
 *
 * `limit`/`skip` page it — the panel scrolls rather than loading a history
 * that can be tens of thousands of commits long.
 */
async function log(git, { projectPath, ref, limit = 50, skip = 0, withFiles = false }) {
  const args = ['log', `--format=${LOG_FORMAT}`, `-n${limit}`, `--skip=${skip}`];
  // One call for the whole page, files included. The alternative — a `git
  // show` per commit to find out what it touched — is fifty processes to draw
  // one screen, and the panel needs the files to say "you changed Home"
  // rather than just the subject line.
  if (withFiles) args.push('--name-status', ...DIFF_FLAGS);
  if (ref) args.push(ref);
  let stdout;
  try {
    ({ stdout } = await git(projectPath, args));
  } catch (err) {
    // A project that has just been initialised has a branch and no commits.
    // That is an empty history, not a broken one.
    if (isEmptyRepo(err)) return { commits: [], atEnd: true };
    throw err;
  }
  const commits = stdout
    .split(RS)
    .filter((rec) => rec.trim())
    .map((rec) => {
      // The first line is the format; anything after it is the file list this
      // commit touched, when one was asked for.
      const nl = rec.indexOf('\n');
      const head = nl === -1 ? rec : rec.slice(0, nl);
      const rest = nl === -1 ? '' : rec.slice(nl + 1);
      const [hash, shortHash, author, email, when, subject, parents, refs] = head.split(US);
      return {
        files: withFiles ? parseNameStatus(rest) : undefined,
        hash,
        shortHash,
        author,
        email,
        when, // ISO 8601 with offset; the panel decides how to say it
        subject,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        // "HEAD -> main, origin/main, tag: v1" — what to badge the row with.
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        isMerge: (parents ? parents.split(' ').filter(Boolean) : []).length > 1,
      };
    });
  // Asked for one more than we need? No — `atEnd` is inferred from a short
  // page, which costs nothing and is right except when the history length is
  // an exact multiple of the page size (one extra empty fetch).
  return { commits, atEnd: commits.length < limit };
}

/** What one commit changed: `{status, path, from}` per file. */
async function commitFiles(git, { projectPath, ref }) {
  const { stdout } = await git(projectPath, [
    'show',
    '--name-status',
    '--format=',
    ...DIFF_FLAGS,
    ref,
  ]);
  return parseNameStatus(stdout);
}

function parseNameStatus(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0];
    // A rename or copy is "R100\told\tnew" — a similarity score on the code
    // and two paths. Everything else is one code and one path.
    if (/^[RC]/.test(code) && parts.length >= 3) {
      files.push({ status: code[0], path: parts[2], from: parts[1] });
    } else if (parts.length >= 2) {
      files.push({ status: code[0], path: parts[1] });
    }
  }
  return files;
}

/**
 * Everything changed right now, for the file picker — the whole list, with
 * what happened to each file. `git:info` keeps its own capped summary for the
 * chip; this is the one that has to be complete, because a file missing from
 * it is a file that silently cannot be committed.
 */
async function status(git, { projectPath }) {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  const files = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // Porcelain v1 is "XY path": two status columns, a space, then the path.
    // Not trimmed before slicing — the first column is a space for changes
    // that are only in the working tree, and trimming loses that distinction.
    const code = line.slice(0, 2);
    let p = line.slice(3);
    let from;
    // "R  old -> new" — staged renames carry both names.
    const arrow = p.lastIndexOf(' -> ');
    if (arrow !== -1) {
      from = unquote(p.slice(0, arrow));
      p = p.slice(arrow + 4);
    }
    files.push({
      path: unquote(p),
      from,
      // The letter to show. `??` is git's "untracked", which to anyone who did
      // not choose that spelling is simply a new file.
      status: code === '??' ? 'A' : code.trim()[0] || 'M',
      staged: code[0] !== ' ' && code !== '??',
      untracked: code === '??',
    });
  }
  return files;
}

// Git quotes paths containing non-ASCII or control characters. Only the outer
// quotes are undone here — a path that needed the full C-style unescaping is
// rare enough that showing it slightly wrong beats getting the common case
// wrong by hand-rolling an unescaper.
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

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
async function allFiles(git, { projectPath }) {
  const { stdout } = await git(projectPath, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  const changed = new Map((await status(git, { projectPath })).map((f) => [f.path, f]));
  const paths = [
    ...new Set(
      stdout
        .split('\n')
        .map((l) => unquote(l.trim()))
        .filter(Boolean)
    ),
  ];
  // A deleted file is gone from the working tree, so ls-files still lists it
  // from the index — but a file deleted and staged is not listed at all, and
  // it is exactly the one somebody may want to find and put back.
  for (const [p, f] of changed) if (!paths.includes(p)) paths.push(p);
  return paths.sort().map((p) => {
    const c = changed.get(p);
    return { path: p, status: c ? c.status : null, staged: c ? c.staged : false };
  });
}

/** A file's contents as they were at `ref`, or null when it wasn't there. */
async function fileAt(git, { projectPath, ref, path: filePath }) {
  try {
    const { stdout } = await git(projectPath, ['show', `${ref}:${filePath}`]);
    return stdout;
  } catch (err) {
    // Not an error worth raising: a file that did not exist yet is a normal
    // answer to "what did this look like then", and the caller wants to say
    // "this page didn't exist yet" rather than show a failure.
    if (/does not exist|exists on disk, but not in/i.test(String(err.stderr || ''))) return null;
    throw err;
  }
}

/** Every worktree of this repository, the main one first. */
async function worktrees(git, { projectPath }) {
  const { stdout } = await git(projectPath, ['worktree', 'list', '--porcelain']);
  // Blank-line-separated records of "key value" lines. `detached` and `bare`
  // are bare keys with no value.
  return stdout
    .split('\n\n')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const out = { path: null, head: null, branch: null, detached: false, bare: false };
      for (const line of rec.split('\n')) {
        const sp = line.indexOf(' ');
        const key = sp === -1 ? line : line.slice(0, sp);
        const value = sp === -1 ? '' : line.slice(sp + 1);
        if (key === 'worktree') out.path = value;
        else if (key === 'HEAD') out.head = value;
        else if (key === 'branch') out.branch = value.replace(/^refs\/heads\//, '');
        else if (key === 'detached') out.detached = true;
        else if (key === 'bare') out.bare = true;
      }
      return out;
    })
    .filter((w) => w.path);
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

const TITLE = (seg) =>
  seg
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

/**
 * `{ path, kind, label }` for one repo-relative path.
 *
 * `kind` is for the icon, `label` is what the row says. A path this knows
 * nothing about keeps its own name rather than being forced into a category —
 * a wrong label is worse than a plain one.
 */
function describeFile(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const base = p.split('/').pop() || p;

  const page = p.match(/^src\/pages\/(.+)\.(astro|mdx?)$/i);
  if (page) {
    let route = page[1];
    if (route === 'index') return { path: p, kind: 'page', label: 'Home' };
    // "about/index" is the same page as "about" — the folder is the route.
    if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
    return { path: p, kind: 'page', label: route.split('/').map(TITLE).join(' / ') };
  }
  const comp = p.match(/^src\/components\/(.+)\.(astro|jsx?|tsx?|vue|svelte)$/i);
  if (comp) return { path: p, kind: 'component', label: comp[1].split('/').pop() };

  const layout = p.match(/^src\/layouts\/(.+)\.(astro|jsx?|tsx?)$/i);
  if (layout) return { path: p, kind: 'layout', label: layout[1].split('/').pop() };

  if (/^src\/content\//i.test(p)) return { path: p, kind: 'content', label: base };
  if (/^public\//i.test(p)) return { path: p, kind: 'asset', label: base };
  if (/\.(css|scss|sass|less)$/i.test(p)) return { path: p, kind: 'style', label: base };
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i.test(p)) {
    return { path: p, kind: 'asset', label: base };
  }
  // Config and lockfiles are the ones a designer should not be asked to read.
  if (/^(package(-lock)?\.json|astro\.config\.[a-z]+|tsconfig\.json|\.gitignore)$/i.test(p)) {
    return { path: p, kind: 'config', label: base };
  }
  // Script and prose get named rather than falling into the catch-all. Both
  // are things people change on purpose and go looking for by type — a
  // stylesheet is offered as a stylesheet, and a script should be too.
  if (/\.(m|c)?[jt]sx?$/i.test(p)) return { path: p, kind: 'script', label: base };
  if (/\.mdx?$/i.test(p)) return { path: p, kind: 'doc', label: base };
  // Anything genuinely unrecognised keeps its own path. Guessing a category
  // for it would be worse than saying where it is.
  return { path: p, kind: 'file', label: p };
}

/** Every file in a list, described. Renames keep where they came from. */
const describeFiles = (files) =>
  (files || []).map((f) => ({ ...f, ...describeFile(f.path), from: f.from }));

module.exports = {
  allFiles,
  log,
  commitFiles,
  status,
  fileAt,
  worktrees,
  parseNameStatus,
  describeFile,
  describeFiles,
};

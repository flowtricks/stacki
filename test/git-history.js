// Reading history.
//
//   node test/git-history.js
//
// Against real repositories, because every trap in this code is a shape of
// git's output rather than a behaviour, and each one fails by producing a
// plausible wrong answer instead of an error:
//
//   - `git show --name-status` on a merge commit prints nothing at all. A
//     history panel reading it straight draws every merge as a commit that
//     changed no files, and nothing anywhere reports a problem. That is the
//     single most important case in this file.
//   - A repository with no commits makes `git log` exit 128. A new project is
//     an empty history, not a broken one.
//   - A rename is two paths in a commit and one in the working tree, and the
//     record for it has a field the others do not.
//
// Subjects are deliberately awkward here — tabs, newlines, quotes — because
// the log format is delimited, and a delimiter a commit message can contain
// is a parser that breaks on somebody's commit message a year from now.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const history = require('../electron/gitHistory.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// LC_ALL as main.js's runner sets it: git is translated, and both this test and
// the code it exercises read git's words. Without it the suite passes or fails
// by the locale of whoever runs it.
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1 << 24, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sh = async (dir, ...args) => (await git(dir, args)).stdout.trim();

async function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-hist-${name}-`));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'tim@example.com');
  await sh(dir, 'config', 'user.name', 'Tim Ricks');
  return dir;
}

const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

const commit = async (dir, subject) => {
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', subject);
  return sh(dir, 'rev-parse', 'HEAD');
};

(async () => {
  const cleanup = [];

  // --- A repository with nothing in it yet ---------------------------------
  {
    const dir = await repo('empty');
    cleanup.push(dir);
    const r = await history.log(git, { projectPath: dir });
    // git exits 128 here. An editor that surfaced that would greet every new
    // project with an error where its history should be.
    check('a repo with no commits has an empty history', Array.isArray(r.commits), JSON.stringify(r));
    check('and it is empty rather than failing', r.commits.length === 0, JSON.stringify(r));
    check('and it reports the end of the list', r.atEnd === true);

    // Nothing committed, but files on disk — the file picker must still see
    // them, because at this point they are the entire project.
    write(dir, 'src/pages/index.astro', 'hello\n');
    const st = await history.status(git, { projectPath: dir });
    check('untracked files show before the first commit', st.length === 1, JSON.stringify(st));
    check('and read as added, not as git’s "??"', st[0].status === 'A', JSON.stringify(st[0]));
    check('and are flagged untracked', st[0].untracked === true, JSON.stringify(st[0]));
  }

  // --- An ordinary history -------------------------------------------------
  {
    const dir = await repo('log');
    cleanup.push(dir);
    write(dir, 'src/pages/index.astro', 'one\n');
    await commit(dir, 'first page');
    write(dir, 'src/pages/about.astro', 'two\n');
    await commit(dir, 'about page');

    const { commits } = await history.log(git, { projectPath: dir });
    check('the log comes back newest first', commits[0].subject === 'about page', commits[0]?.subject);
    check('with both commits', commits.length === 2, String(commits.length));
    check('the author is carried', commits[0].author === 'Tim Ricks', commits[0].author);
    check('the date parses', !Number.isNaN(Date.parse(commits[0].when)), commits[0].when);
    check('the short hash is a prefix of the full one', commits[0].hash.startsWith(commits[0].shortHash));
    check('an ordinary commit is not a merge', commits[0].isMerge === false);
    check('the branch it is on is carried as a ref', commits[0].refs.join(',').includes('main'), commits[0].refs.join(','));
    check('the root commit has no parents', commits[1].parents.length === 0, JSON.stringify(commits[1].parents));

    const files = await history.commitFiles(git, { projectPath: dir, ref: commits[0].hash });
    check('a commit lists what it changed', files.length === 1, JSON.stringify(files));
    check('with the path', files[0].path === 'src/pages/about.astro', JSON.stringify(files[0]));
    check('and the letter for a new file', files[0].status === 'A', JSON.stringify(files[0]));

    // The root commit: no parent to diff against, and git handles it, but only
    // if the flags do not assume there is one.
    const rootFiles = await history.commitFiles(git, { projectPath: dir, ref: commits[1].hash });
    check('the very first commit lists its files too', rootFiles.length === 1, JSON.stringify(rootFiles));
  }

  // --- A subject line that fights the parser -------------------------------
  {
    const dir = await repo('nasty');
    cleanup.push(dir);
    write(dir, 'a.txt', 'x\n');
    // Tabs and quotes in a subject. A format delimited by tabs or spaces
    // splits this into the wrong number of fields and shifts every value
    // after it — the author becomes part of the message, silently.
    await commit(dir, 'fix\tthe "quoted" thing | and > that');
    const { commits } = await history.log(git, { projectPath: dir });
    check(
      'a subject with tabs and quotes survives intact',
      commits[0].subject === 'fix\tthe "quoted" thing | and > that',
      JSON.stringify(commits[0].subject)
    );
    check('and the fields after it are not shifted', commits[0].author === 'Tim Ricks', commits[0].author);
  }

  // --- Merge commits: the case that fails silently -------------------------
  {
    const dir = await repo('merge');
    cleanup.push(dir);
    write(dir, 'src/pages/index.astro', 'base\n');
    await commit(dir, 'first');
    await sh(dir, 'checkout', '-qb', 'feature');
    write(dir, 'src/pages/feature.astro', 'from the feature\n');
    await commit(dir, 'feature page');
    await sh(dir, 'checkout', '-q', 'main');
    write(dir, 'src/pages/main.astro', 'from main\n');
    await commit(dir, 'main page');
    await sh(dir, 'merge', '--no-edit', '-q', 'feature');

    const { commits } = await history.log(git, { projectPath: dir });
    const merge = commits.find((c) => c.isMerge);
    check('a merge commit is in the log', !!merge, commits.map((c) => c.subject).join(' | '));
    check('and is marked as a merge', merge && merge.parents.length === 2, JSON.stringify(merge?.parents));

    // The whole point of this file. Bare `git show --name-status` returns an
    // empty string here, and every merge in the panel would read as a commit
    // that touched nothing.
    // The work done ON the branch has to still be in the history. Asking git
    // for a merge's diff against its first parent and asking it to FOLLOW only
    // the first parent are one letter apart in the flags and look identical on
    // a repository with no merges — but `--first-parent` on `git log` stops
    // following the second parent, so every commit made on a branch vanishes
    // from the timeline the moment that branch is merged. The merge stays,
    // sitting there as though nothing came with it.
    check(
      'commits made on the merged branch are still listed',
      commits.some((c) => c.subject === 'feature page'),
      commits.map((c) => c.subject).join(' | ')
    );
    check(
      'along with the ones made on this branch',
      commits.some((c) => c.subject === 'main page'),
      commits.map((c) => c.subject).join(' | ')
    );
    check('so the whole history is there', commits.length === 4, String(commits.length));

    const files = await history.commitFiles(git, { projectPath: dir, ref: merge.hash });
    check('a merge reports the files it brought in', files.length > 0, JSON.stringify(files));
    check(
      'namely the branch’s work',
      files.some((f) => f.path === 'src/pages/feature.astro'),
      JSON.stringify(files)
    );
  }

  // --- Renames -------------------------------------------------------------
  {
    const dir = await repo('rename');
    cleanup.push(dir);
    write(dir, 'src/pages/about.astro', 'a page with enough text in it to match on\n'.repeat(4));
    await commit(dir, 'about');
    await sh(dir, 'mv', 'src/pages/about.astro', 'src/pages/contact.astro');
    const ref = await commit(dir, 'renamed');

    const files = await history.commitFiles(git, { projectPath: dir, ref });
    check('a rename is one entry, not a delete and an add', files.length === 1, JSON.stringify(files));
    check('marked as a rename', files[0].status === 'R', JSON.stringify(files[0]));
    check('with the new path', files[0].path === 'src/pages/contact.astro', JSON.stringify(files[0]));
    check('and where it came from', files[0].from === 'src/pages/about.astro', JSON.stringify(files[0]));
  }

  // --- The working tree right now ------------------------------------------
  {
    const dir = await repo('status');
    cleanup.push(dir);
    write(dir, 'keep.txt', 'kept\n');
    write(dir, 'gone.txt', 'going\n');
    write(dir, 'edit.txt', 'before\n');
    await commit(dir, 'base');

    write(dir, 'edit.txt', 'after\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    write(dir, 'new.txt', 'brand new\n');

    const st = await history.status(git, { projectPath: dir });
    const by = Object.fromEntries(st.map((f) => [f.path, f]));
    check('an edited file is listed', !!by['edit.txt'], JSON.stringify(st));
    check('a deleted file is listed', by['gone.txt']?.status === 'D', JSON.stringify(by['gone.txt']));
    check('a new file is listed', by['new.txt']?.status === 'A', JSON.stringify(by['new.txt']));
    check('an untouched file is not listed', !by['keep.txt'], JSON.stringify(st));
    // Worktree-only changes have a leading space in the porcelain code. If the
    // line were trimmed before slicing, the path would lose its first
    // character and every unstaged file would come back misnamed.
    check('the path of an unstaged edit is intact', by['edit.txt']?.path === 'edit.txt', JSON.stringify(by['edit.txt']));
    check('and it is not marked staged', by['edit.txt']?.staged === false, JSON.stringify(by['edit.txt']));
  }

  // --- A file as it was ----------------------------------------------------
  {
    const dir = await repo('fileat');
    cleanup.push(dir);
    write(dir, 'src/pages/index.astro', 'the old words\n');
    const first = await commit(dir, 'first');
    write(dir, 'src/pages/index.astro', 'the new words\n');
    await commit(dir, 'second');

    const then = await history.fileAt(git, { projectPath: dir, ref: first, path: 'src/pages/index.astro' });
    check('a file can be read as it was', then.trim() === 'the old words', JSON.stringify(then));
    // "It did not exist yet" is a real answer to the question, and the panel
    // wants to say so rather than show a failure.
    const missing = await history.fileAt(git, { projectPath: dir, ref: first, path: 'src/pages/later.astro' });
    check('a file that did not exist yet reads as null', missing === null, JSON.stringify(missing));
  }

  // --- Paging --------------------------------------------------------------
  {
    const dir = await repo('paging');
    cleanup.push(dir);
    for (let i = 0; i < 7; i++) {
      write(dir, `f${i}.txt`, `${i}\n`);
      await commit(dir, `commit ${i}`);
    }
    const first = await history.log(git, { projectPath: dir, limit: 3 });
    check('a page holds the limit', first.commits.length === 3, String(first.commits.length));
    check('and knows it is not the end', first.atEnd === false);
    check('newest first', first.commits[0].subject === 'commit 6', first.commits[0].subject);

    const second = await history.log(git, { projectPath: dir, limit: 3, skip: 3 });
    check('the next page continues', second.commits[0].subject === 'commit 3', second.commits[0].subject);
    check(
      'and does not repeat the first page',
      !second.commits.some((c) => first.commits.some((f) => f.hash === c.hash)),
      second.commits.map((c) => c.subject).join(',')
    );

    const last = await history.log(git, { projectPath: dir, limit: 3, skip: 6 });
    check('the final short page is the end', last.atEnd === true, JSON.stringify(last.commits.length));
  }

  // --- Worktrees -----------------------------------------------------------
  {
    const dir = await repo('worktrees');
    cleanup.push(dir);
    write(dir, 'a.txt', 'x\n');
    await commit(dir, 'first');

    const one = await history.worktrees(git, { projectPath: dir });
    check('the main checkout is a worktree', one.length === 1, JSON.stringify(one));
    check('on its branch', one[0].branch === 'main', JSON.stringify(one[0]));
    check('and not detached', one[0].detached === false, JSON.stringify(one[0]));

    const extra = path.join(dir, '..', `${path.basename(dir)}-wt`);
    await sh(dir, 'worktree', 'add', '-q', '--detach', extra, 'HEAD');
    cleanup.push(extra);
    const two = await history.worktrees(git, { projectPath: dir });
    check('an added worktree shows up', two.length === 2, JSON.stringify(two));
    const det = two.find((w) => w.path !== one[0].path);
    // A detached worktree is exactly what commit preview creates, so this is
    // the shape the panel will actually be rendering.
    check('a detached one is marked detached', det?.detached === true, JSON.stringify(det));
    check('and has no branch', det?.branch === null, JSON.stringify(det));
    await sh(dir, 'worktree', 'remove', '--force', extra);
    check(
      'and it is gone once removed',
      (await history.worktrees(git, { projectPath: dir })).length === 1
    );
  }

  // --- A page of commits with their files, in one call ----------------------
  {
    const dir = await repo('withfiles');
    cleanup.push(dir);
    write(dir, 'src/pages/index.astro', 'base\n');
    await commit(dir, 'first');
    await sh(dir, 'checkout', '-qb', 'feature');
    write(dir, 'src/pages/feature.astro', 'f\n');
    await commit(dir, 'feature page');
    await sh(dir, 'checkout', '-q', 'main');
    write(dir, 'src/pages/main.astro', 'm\n');
    await commit(dir, 'main page');
    await sh(dir, 'merge', '--no-edit', '-q', 'feature');
    write(dir, 'src/pages/index.astro', 'changed\n');
    write(dir, 'src/pages/two.astro', 'two\n');
    await commit(dir, 'two files at once');

    const { commits } = await history.log(git, { projectPath: dir, withFiles: true });
    const top = commits[0];
    check('a commit carries its files', top.files?.length === 2, JSON.stringify(top.files));
    check(
      'both of them',
      top.files.map((f) => f.path).sort().join(',') === 'src/pages/index.astro,src/pages/two.astro',
      JSON.stringify(top.files)
    );
    check('an edit reads as modified', top.files.find((f) => f.path === 'src/pages/index.astro').status === 'M');

    // The same merge trap, on the path the panel actually uses. A page drawn
    // from this call would show every merge as touching nothing.
    const merge = commits.find((c) => c.isMerge);
    check('a merge in a page carries its files too', merge?.files?.length > 0, JSON.stringify(merge?.files));
    // The same trap on the paged call the panel actually uses.
    check(
      'and the merged branch’s own commit is in the page',
      commits.some((c) => c.subject === 'feature page'),
      commits.map((c) => c.subject).join(' | ')
    );

    // The record separator leads each record so a file list lands with the
    // commit it belongs to. If it trailed, every file list would attach to the
    // NEXT commit — every row wrong, none of them empty, nothing to notice.
    const first = commits.find((c) => c.subject === 'first');
    check(
      'files land on the right commit',
      first.files.length === 1 && first.files[0].path === 'src/pages/index.astro',
      JSON.stringify(first.files)
    );

    // Without the flag there is no files key at all, rather than an empty
    // array that would read as "this commit changed nothing".
    const plain = await history.log(git, { projectPath: dir });
    check('files are absent unless asked for', plain.commits[0].files === undefined, JSON.stringify(plain.commits[0].files));
  }

  // --- Saying what a file is ------------------------------------------------
  {
    const d = (p) => history.describeFile(p);
    check('the index page is Home', d('src/pages/index.astro').label === 'Home', d('src/pages/index.astro').label);
    check('a page is its route, in words', d('src/pages/about.astro').label === 'About', d('src/pages/about.astro').label);
    check('dashes become spaces', d('src/pages/about-us.astro').label === 'About us', d('src/pages/about-us.astro').label);
    // A folder's index is that folder's page, not a page called "index".
    check('a folder index is the folder', d('src/pages/blog/index.astro').label === 'Blog', d('src/pages/blog/index.astro').label);
    check('a component is its name', d('src/components/Card.astro').label === 'Card', d('src/components/Card.astro').label);
    check('and is marked a component', d('src/components/Card.astro').kind === 'component');
    check('a layout is marked a layout', d('src/layouts/Base.astro').kind === 'layout');
    check('something in public is an asset', d('public/logo.svg').kind === 'asset');
    check('a stylesheet is a style', d('src/styles.css').kind === 'style');
    check('package.json is config', d('package.json').kind === 'config');
    // A path this knows nothing about keeps its own name. Guessing a label for
    // it would be worse than saying the path.
    check('an unknown path keeps its path', d('scripts/deploy.sh').label === 'scripts/deploy.sh', d('scripts/deploy.sh').label);
    check('and no invented kind', d('scripts/deploy.sh').kind === 'file');
    // Windows separators reach this from a checkout made there.
    check('backslashes are understood', d('src\\pages\\index.astro').label === 'Home', d('src\\pages\\index.astro').label);

    const described = history.describeFiles([{ status: 'R', path: 'src/pages/contact.astro', from: 'src/pages/about.astro' }]);
    check('describing a list keeps the status', described[0].status === 'R', JSON.stringify(described[0]));
    check('and keeps where a rename came from', described[0].from === 'src/pages/about.astro', JSON.stringify(described[0]));
    check('and labels it', described[0].label === 'Contact', JSON.stringify(described[0]));
  }

  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`git-history: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-history: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

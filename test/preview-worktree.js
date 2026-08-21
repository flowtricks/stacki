// The checkout an old version is previewed from.
//
//   node test/preview-worktree.js
//
// Everything the dev server needs to be true before it starts, checked without
// starting one. Booting Astro is the slow, environment-dependent half; this is
// the half that can go wrong quietly.
//
// The case that matters most is the LAST one: the preview checkout lives
// inside the user's project, so if git can see it, it appears as an untracked
// folder in their own status — in the file picker, in the commit box — and the
// first thing anybody would do is commit the editor's scratch directory into
// their site. It is hidden through .git/info/exclude rather than .gitignore
// because .gitignore is the user's file, tracked, and writing to it would be a
// change they did not make.
//
// (Why inside the project at all, when out of the way seems obviously better:
// a worktree has no node_modules, and symlinking the project's breaks Astro's
// subpath exports — Node resolves the symlink to its real path first, so
// `astro/app` is looked for in the wrong place and the server dies. Inside the
// project there is no symlink and resolution just walks up. Verified against a
// real Astro 7 project before this was written.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const wt = require('../electron/previewWorktree.js');

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
    execFile('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sh = async (dir, ...args) => (await git(dir, args)).stdout.trim();

const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

async function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-'));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'tim@example.com');
  await sh(dir, 'config', 'user.name', 'Tim Ricks');
  write(dir, 'src/pages/index.astro', 'version one\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'one');
  const first = await sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/pages/index.astro', 'version two\n');
  write(dir, 'src/pages/added-later.astro', 'new page\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'two');
  return { dir, first, second: await sh(dir, 'rev-parse', 'HEAD') };
}

(async () => {
  const cleanup = [];

  // --- Making one ----------------------------------------------------------
  {
    const { dir, first } = await project();
    cleanup.push(dir);
    const made = await wt.ensureWorktree(git, { projectPath: dir, ref: first });
    check('a checkout is made', fs.existsSync(made), made);
    check('inside the project', made.startsWith(dir), made);
    // The whole point: it holds the OLD version while the real tree holds the
    // new one.
    check('holding the old version', read(made, 'src/pages/index.astro') === 'version one\n', read(made, 'src/pages/index.astro'));
    check('without the page added since', !fs.existsSync(path.join(made, 'src/pages/added-later.astro')));
    check('and the real project is untouched', read(dir, 'src/pages/index.astro') === 'version two\n');

    // Detached on purpose: a branch cannot be checked out in two places, and
    // previewing the commit a branch happens to sit on is entirely normal.
    const head = await sh(made, 'rev-parse', 'HEAD');
    check('the checkout is at the right commit', head === first, head);
    check('and not on a branch', (await sh(made, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'HEAD');

    // Node resolution has to walk up to the project's real node_modules. A
    // node_modules of its own — or a symlink — is what breaks Astro.
    check('it has no node_modules of its own', !fs.existsSync(path.join(made, 'node_modules')));
  }

  // --- Moving it rather than making another --------------------------------
  {
    const { dir, first, second } = await project();
    cleanup.push(dir);
    const a = await wt.ensureWorktree(git, { projectPath: dir, ref: first });
    const b = await wt.ensureWorktree(git, { projectPath: dir, ref: second });
    check('the same checkout is reused', a === b, `${a} vs ${b}`);
    check('moved to the new commit', read(b, 'src/pages/index.astro') === 'version two\n', read(b, 'src/pages/index.astro'));
    check('with the newer page now present', fs.existsSync(path.join(b, 'src/pages/added-later.astro')));
    // One worktree, not one per commit — otherwise browsing history costs a
    // full copy of the project per click.
    const listed = (await sh(dir, 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).length;
    check('there is still only one extra checkout', listed === 2, String(listed));

    // Going back again has to leave nothing of the newer version behind.
    const c = await wt.ensureWorktree(git, { projectPath: dir, ref: first });
    check('moving back removes what was newer', !fs.existsSync(path.join(c, 'src/pages/added-later.astro')));
  }

  // --- Stale leftovers -----------------------------------------------------
  {
    const { dir, first } = await project();
    cleanup.push(dir);
    // A crash can leave the folder without git knowing about it. `worktree
    // add` onto an existing directory fails, so this must clear it first
    // rather than leaving preview permanently broken for that project.
    const dead = wt.previewPath(dir);
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, 'junk.txt'), 'left over\n');
    const made = await wt.ensureWorktree(git, { projectPath: dir, ref: first });
    check('a leftover folder does not block it', fs.existsSync(made), made);
    check('and the junk is gone', !fs.existsSync(path.join(made, 'junk.txt')));
    check('with the version actually checked out', read(made, 'src/pages/index.astro') === 'version one\n');
  }

  // --- Taking it away ------------------------------------------------------
  {
    const { dir, first } = await project();
    cleanup.push(dir);
    const made = await wt.ensureWorktree(git, { projectPath: dir, ref: first });
    await wt.removeWorktree(git, { projectPath: dir });
    check('the checkout is gone', !fs.existsSync(made), made);
    check('and its folder with it', !fs.existsSync(path.join(dir, '.stacki')));
    const listed = (await sh(dir, 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).length;
    check('git no longer lists it', listed === 1, String(listed));
    // Removing one that was never there is what happens on every ordinary
    // project close, so it must be silent rather than an error.
    const again = await wt.removeWorktree(git, { projectPath: dir });
    check('removing it twice is harmless', again.ok === true);
  }

  // --- Git must not see it -------------------------------------------------
  {
    const { dir, first } = await project();
    cleanup.push(dir);
    await wt.ensureWorktree(git, { projectPath: dir, ref: first });

    // The case this file exists for. Without the exclude, the user's own
    // project reports an untracked folder full of the editor's scratch files,
    // and the file picker offers to commit it.
    const status = await sh(dir, 'status', '--porcelain');
    check('the project stays clean', status === '', `git sees:\n${status}`);
    check('and git agrees it is ignored', (await sh(dir, 'check-ignore', '.stacki')) === '.stacki');

    // .gitignore is the user's file. Writing to it would be a change they did
    // not make, and it would follow them into their next commit.
    check('the user’s .gitignore was not touched', !fs.existsSync(path.join(dir, '.gitignore')));
    const exclude = read(dir, '.git/info/exclude');
    check('the local exclude carries it instead', /\.stacki\//.test(exclude || ''), exclude);

    // Called on every preview, so it must not pile up.
    wt.ensureExcluded(dir);
    wt.ensureExcluded(dir);
    const lines = (read(dir, '.git/info/exclude') || '').split('\n').filter((l) => l.trim() === '.stacki/');
    check('and is not written twice', lines.length === 1, String(lines.length));
  }

  for (const dir of cleanup) {
    try {
      await git(dir, ['worktree', 'remove', '--force', wt.previewPath(dir)]);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`preview-worktree: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`preview-worktree: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

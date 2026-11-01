// The checkout an old version is previewed from.
//
//   node test/electron/preview/previewWorktree.test.js
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
const wt = require('#dist/electron/preview/previewWorktree.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });

const sh = async (directory, ...args) => (await git(directory, args)).stdout.trim();

const write = (directory, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true });
  fs.writeFileSync(path.join(directory, rel), body);
};
const read = (directory, rel) => {
  try {
    return fs.readFileSync(path.join(directory, rel), 'utf8');
  } catch {
    return undefined;
  }
};

async function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-'));
  await sh(directory, 'init', '-q', '-b', 'main', '.');
  await sh(directory, 'config', 'core.autocrlf', 'false');
  await sh(directory, 'config', 'user.email', 'tim@example.com');
  await sh(directory, 'config', 'user.name', 'Tim Ricks');
  write(directory, 'src/pages/index.astro', 'version one\n');
  await sh(directory, 'add', '-A');
  await sh(directory, 'commit', '-qm', 'one');
  const first = await sh(directory, 'rev-parse', 'HEAD');
  write(directory, 'src/pages/index.astro', 'version two\n');
  write(directory, 'src/pages/added-later.astro', 'new page\n');
  await sh(directory, 'add', '-A');
  await sh(directory, 'commit', '-qm', 'two');
  return { dir: directory, first, second: await sh(directory, 'rev-parse', 'HEAD') };
}

(async () => {
  const cleanup = [];

  // --- Making one ----------------------------------------------------------
  {
    const { dir: directory, first } = await project();
    cleanup.push(directory);
    const made = await wt.ensureWorktree(git, { projectPath: directory, ref: first });
    check('a checkout is made', fs.existsSync(made), made);
    check('inside the project', made.startsWith(directory), made);
    // The whole point: it holds the OLD version while the real tree holds the
    // new one.
    check('holding the old version', read(made, 'src/pages/index.astro') === 'version one\n', read(made, 'src/pages/index.astro'));
    check('without the page added since', !fs.existsSync(path.join(made, 'src/pages/added-later.astro')));
    check('and the real project is untouched', read(directory, 'src/pages/index.astro') === 'version two\n');

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
    const { dir: directory, first, second } = await project();
    cleanup.push(directory);
    const firstWorktree = await wt.ensureWorktree(git, { projectPath: directory, ref: first });
    const secondWorktree = await wt.ensureWorktree(git, { projectPath: directory, ref: second });
    check('the same checkout is reused', firstWorktree === secondWorktree, `${firstWorktree} vs ${secondWorktree}`);
    check('moved to the new commit', read(secondWorktree, 'src/pages/index.astro') === 'version two\n', read(secondWorktree, 'src/pages/index.astro'));
    check('with the newer page now present', fs.existsSync(path.join(secondWorktree, 'src/pages/added-later.astro')));
    // One worktree, not one per commit — otherwise browsing history costs a
    // full copy of the project per click.
    const listed = (await sh(directory, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree ')).length;
    check('there is still only one extra checkout', listed === 2, String(listed));

    // Going back again has to leave nothing of the newer version behind.
    const againWorktree = await wt.ensureWorktree(git, { projectPath: directory, ref: first });
    check('moving back removes what was newer', !fs.existsSync(path.join(againWorktree, 'src/pages/added-later.astro')));
  }

  // --- Stale leftovers -----------------------------------------------------
  {
    const { dir: directory, first } = await project();
    cleanup.push(directory);
    // A crash can leave the folder without git knowing about it. `worktree
    // add` onto an existing directory fails, so this must clear it first
    // rather than leaving preview permanently broken for that project.
    const dead = wt.previewPath(directory);
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, 'junk.txt'), 'left over\n');
    const made = await wt.ensureWorktree(git, { projectPath: directory, ref: first });
    check('a leftover folder does not block it', fs.existsSync(made), made);
    check('and the junk is gone', !fs.existsSync(path.join(made, 'junk.txt')));
    check('with the version actually checked out', read(made, 'src/pages/index.astro') === 'version one\n');
  }

  // --- Taking it away ------------------------------------------------------
  {
    const { dir: directory, first } = await project();
    cleanup.push(directory);
    const made = await wt.ensureWorktree(git, { projectPath: directory, ref: first });
    await wt.removeWorktree(git, { projectPath: directory });
    check('the checkout is gone', !fs.existsSync(made), made);
    check('and its folder with it', !fs.existsSync(path.join(directory, '.stacki')));
    const listed = (await sh(directory, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree ')).length;
    check('git no longer lists it', listed === 1, String(listed));
    // Removing one that was never there is what happens on every ordinary
    // project close, so it must be silent rather than an error.
    const again = await wt.removeWorktree(git, { projectPath: directory });
    check('removing it twice is harmless', again.ok === true);
  }

  // --- Git must not see it -------------------------------------------------
  {
    const { dir: directory, first } = await project();
    cleanup.push(directory);
    await wt.ensureWorktree(git, { projectPath: directory, ref: first });

    // The case this file exists for. Without the exclude, the user's own
    // project reports an untracked folder full of the editor's scratch files,
    // and the file picker offers to commit it.
    const status = await sh(directory, 'status', '--porcelain');
    check('the project stays clean', status === '', `git sees:\n${status}`);
    check('and git agrees it is ignored', (await sh(directory, 'check-ignore', '.stacki/preview/')) === '.stacki/preview/');

    // .gitignore is the user's file. Writing to it would be a change they did
    // not make, and it would follow them into their next commit.
    check('the user’s .gitignore was not touched', !fs.existsSync(path.join(directory, '.gitignore')));
    const exclude = read(directory, '.git/info/exclude');
    check('the local exclude carries it instead', /\.stacki\//.test(exclude || ''), exclude);

    // Called on every preview, so it must not pile up.
    wt.ensureExcluded(directory);
    wt.ensureExcluded(directory);
    check('save staging is excluded', exclude.includes('.stacki/io/'));
    const lines = (read(directory, '.git/info/exclude') || '').split('\n').filter((line) => line.trim() === '.stacki/preview/');
    check('and is not written twice', lines.length === 1, String(lines.length));
  }

  for (const directory of cleanup) {
    try {
      await git(directory, ['worktree', 'remove', '--force', wt.previewPath(directory)]);
    } catch {
      /* already gone */
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`preview-worktree: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`preview-worktree: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

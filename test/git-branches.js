// Merging a branch and deleting one.
//
//   node test/git-branches.js
//
// Against real repositories, because the whole of this code is a reading of
// what git says when it refuses, and git says it in places that are easy to
// guess wrong about. The conflict report goes to STDOUT — stderr is empty —
// so a handler reading only stderr sees a merge that failed for no stated
// reason and passes an empty string to the user. That is the bug this file
// exists to catch.
//
// The other half is what happens to the working tree. A conflicted merge
// leaves conflict markers in the files, and this editor parses those files as
// markup a moment later; the page would come back broken with nothing to say
// why. So a merge that cannot complete has to leave the branch exactly as it
// found it, and that is checked here as a property of the tree, not of the
// message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { mergeBranch, deleteBranch } = require('../electron/gitBranches.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The runner the module takes, without main.js's PATH repair — nothing here
// runs from a packaged app.
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sh = async (cwd, ...args) => (await git(cwd, args)).stdout.trim();

// A repository on `main` with one commit, and a `feature` branch off it.
async function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'test@example.com');
  await sh(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'first');
  return dir;
}

const commitOn = async (dir, branch, file, body) => {
  await sh(dir, 'checkout', '-q', branch);
  fs.writeFileSync(path.join(dir, file), body);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', `${file} on ${branch}`);
};

const caught = async (fn) => {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: String(err.message || err) };
  }
};

(async () => {
  const cleanup = [];

  // --- A merge that has somewhere to go ------------------------------------
  {
    const dir = await repo('ff');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merge that moves work reports it', r.changed === true, JSON.stringify(r));
    check('the merge names the branch merged into', r.into === 'main', r.into);
    check(
      'the merged file is on the branch afterwards',
      fs.existsSync(path.join(dir, 'b.txt'))
    );

    // Once merged, git's safe delete is willing.
    const d = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merged branch deletes without forcing', d.ok === true, JSON.stringify(d));
    const left = await sh(dir, 'branch', '--format=%(refname:short)');
    check('and is gone from the list', left === 'main', left);
  }

  // --- A merge with nothing to bring ---------------------------------------
  {
    const dir = await repo('noop');
    cleanup.push(dir);
    await sh(dir, 'branch', 'behind');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'behind' });
    // "Merged" here would claim work arrived that was already present. The
    // caller says something different on the strength of this flag.
    check('a merge that moves nothing says so', r.changed === false, JSON.stringify(r));
  }

  // --- A merge that conflicts ----------------------------------------------
  {
    const dir = await repo('conflict');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'a.txt', 'feature wins\n');
    await commitOn(dir, 'main', 'a.txt', 'main wins\n');

    const head = await sh(dir, 'rev-parse', 'HEAD');
    const { error } = await caught(() =>
      mergeBranch(git, { projectPath: dir, branch: 'feature' })
    );

    check('a conflicting merge fails', !!error);
    // The bug this file is for: conflicts are reported on stdout, so a handler
    // reading stderr alone ends up with nothing to say.
    check('the conflict names the file it could not reconcile', /a\.txt/.test(error || ''), error);
    check('and names both branches', /feature/.test(error || '') && /main/.test(error || ''), error);

    // The tree, not the message: this is what keeps the editor from parsing
    // conflict markers as markup.
    const status = await sh(dir, 'status', '--porcelain');
    check('nothing is left conflicted in the tree', status === '', status);
    check('the branch is where it was', (await sh(dir, 'rev-parse', 'HEAD')) === head);
    check(
      'no conflict markers were left in the file',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('<<<<<<<')
    );
    check(
      'and the file still says what the branch said',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'main wins'
    );
  }

  // --- A merge over uncommitted work ---------------------------------------
  {
    const dir = await repo('dirty');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'unsaved edit\n');

    const { error } = await caught(() =>
      mergeBranch(git, { projectPath: dir, branch: 'feature' })
    );
    check('a merge into a dirty tree is refused', !!error, error);
    check('and says what to do about it', /commit|park/i.test(error || ''), error);
    check(
      'the uncommitted work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'unsaved edit\n'
    );
  }

  // --- Merging the branch you are on ---------------------------------------
  {
    const dir = await repo('self');
    cleanup.push(dir);
    const { error } = await caught(() => mergeBranch(git, { projectPath: dir, branch: 'main' }));
    check('merging a branch into itself is refused', !!error, error);
  }

  // --- Deleting a branch holding commits of its own ------------------------
  {
    const dir = await repo('unmerged');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'only here\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    // A question, not an error — it comes back as a value so the caller can
    // ask it rather than showing porcelain about `-D`.
    check('an unmerged branch is not deleted', r.ok === false, JSON.stringify(r));
    check('and it is flagged as the question it is', r.unmerged === true, JSON.stringify(r));
    check(
      'the message says what is at stake',
      /commits/i.test(r.message || '') && /feature/.test(r.message || ''),
      r.message
    );
    check(
      'the branch is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );

    const forced = await deleteBranch(git, { projectPath: dir, branch: 'feature', force: true });
    check('forcing deletes it', forced.ok === true, JSON.stringify(forced));
    check(
      'and it is gone',
      !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );
  }

  // --- Deleting the branch you are on --------------------------------------
  {
    const dir = await repo('current');
    cleanup.push(dir);
    const { error } = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'main' }));
    check('the current branch is not deletable', !!error, error);
    check('and the refusal says to switch first', /switch/i.test(error || ''), error);
  }

  // --- Deleting a branch checked out in another worktree --------------------
  {
    const dir = await repo('worktree');
    cleanup.push(dir);
    await sh(dir, 'branch', 'elsewhere');
    const wt = path.join(dir, '..', path.basename(dir) + '-wt');
    await sh(dir, 'worktree', 'add', '-q', wt, 'elsewhere');
    cleanup.push(wt);

    const { error } = await caught(() =>
      deleteBranch(git, { projectPath: dir, branch: 'elsewhere' })
    );
    check('a branch held by another worktree is refused', !!error, error);
    // Git leads with a path nobody asked about; this should lead with the name.
    check('and the refusal says which worktree', /worktree/i.test(error || ''), error);
  }

  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`git-branches: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-branches: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

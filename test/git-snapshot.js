// Saving a version, and going back to one.
//
//   node test/git-snapshot.js
//
// The two halves of one promise: "try it, you can get back" is only true if
// both work. Both are tested against real repositories because both fail in
// the same quiet way — by leaving the working tree in a state that looks
// plausible and is wrong.
//
// The two that matter most here:
//
//   - Saving only some files has to leave the others ALONE. A picker that
//     quietly commits everything is worse than no picker, because the user
//     believes something that isn't true about what they just published.
//   - Going back to an old version has to produce THAT version. A checkout by
//     pathspec leaves behind any file added since — it is tracked, so `clean`
//     will not take it either — and the result is the old project plus the new
//     files: a state that never existed, labelled "how it was".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const snap = require('../electron/gitSnapshot.js');

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

async function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-snap-${name}-`));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'tim@example.com');
  await sh(dir, 'config', 'user.name', 'Tim Ricks');
  return dir;
}

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
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

const caught = async (fn) => {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: String(err.message || err) };
  }
};

(async () => {
  const cleanup = [];

  // --- Saving everything (the default, unchanged) --------------------------
  {
    const dir = await repo('all');
    cleanup.push(dir);
    write(dir, 'a.txt', 'one\n');
    write(dir, 'b.txt', 'two\n');
    const r = await snap.commit(git, { projectPath: dir, message: 'everything' });
    check('saving with no picks saves all of it', r.files === null, JSON.stringify(r));
    check('and the tree is clean after', (await sh(dir, 'status', '--porcelain')) === '');
    check('with the message given', (await sh(dir, 'log', '-1', '--format=%s')) === 'everything');
  }

  // --- Saving only some ----------------------------------------------------
  {
    const dir = await repo('some');
    cleanup.push(dir);
    write(dir, 'a.txt', 'v1\n');
    write(dir, 'b.txt', 'v1\n');
    write(dir, 'gone.txt', 'v1\n');
    await snap.commit(git, { projectPath: dir, message: 'base' });

    write(dir, 'a.txt', 'v2\n');
    write(dir, 'b.txt', 'v2\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    write(dir, 'new.txt', 'brand new\n');

    // a.txt (edited) and gone.txt (deleted) — a delete is one of the commonest
    // edits an editor makes, and `git add` on a missing path is an error
    // rather than the obvious thing.
    const r = await snap.commit(git, {
      projectPath: dir,
      message: 'just these two',
      paths: ['a.txt', 'gone.txt'],
    });
    check('it reports how many were saved', r.files === 2, JSON.stringify(r));

    const saved = await sh(dir, 'show', '--name-status', '--format=', 'HEAD');
    check('the edit is in the commit', /M\s+a\.txt/.test(saved), saved);
    check('the deletion is in the commit', /D\s+gone\.txt/.test(saved), saved);
    check('the file that was not picked is not', !/b\.txt/.test(saved), saved);
    check('nor is the new one', !/new\.txt/.test(saved), saved);

    // The half that makes the picker trustworthy: everything unpicked is still
    // sitting there, changed, exactly as it was.
    const left = await sh(dir, 'status', '--porcelain');
    check('the unpicked edit is still uncommitted', /b\.txt/.test(left), left);
    check('and still says what it said', read(dir, 'b.txt') === 'v2\n', read(dir, 'b.txt'));
    check('the unpicked new file is still there', /new\.txt/.test(left), left);
  }

  // --- Something else already staged ---------------------------------------
  {
    const dir = await repo('staged');
    cleanup.push(dir);
    write(dir, 'a.txt', 'v1\n');
    write(dir, 'b.txt', 'v1\n');
    await snap.commit(git, { projectPath: dir, message: 'base' });

    write(dir, 'a.txt', 'v2\n');
    write(dir, 'b.txt', 'v2\n');
    // Staged by something else — another tool, an earlier action. "Only these"
    // has to mean only these, or a file rides along that nobody chose.
    await sh(dir, 'add', 'b.txt');
    await snap.commit(git, { projectPath: dir, message: 'only a', paths: ['a.txt'] });

    const saved = await sh(dir, 'show', '--name-status', '--format=', 'HEAD');
    check('an already-staged file does not ride along', !/b\.txt/.test(saved), saved);
  }

  // --- Picking nothing ------------------------------------------------------
  {
    const dir = await repo('none');
    cleanup.push(dir);
    write(dir, 'a.txt', 'x\n');
    await snap.commit(git, { projectPath: dir, message: 'base' });
    write(dir, 'a.txt', 'y\n');
    const { error } = await caught(() =>
      snap.commit(git, { projectPath: dir, message: 'nothing', paths: [] })
    );
    // An empty list is a mistake, not "commit everything" — the difference
    // between the two is the whole feature.
    check('picking nothing is refused', !!error, error);
    check('and says so plainly', /pick|choose/i.test(error || ''), error);
    check('and nothing was committed', (await sh(dir, 'log', '-1', '--format=%s')) === 'base');
  }

  // --- Putting one file back ------------------------------------------------
  {
    const dir = await repo('restorefile');
    cleanup.push(dir);
    write(dir, 'src/pages/index.astro', 'the old words\n');
    write(dir, 'other.txt', 'untouched\n');
    await snap.commit(git, { projectPath: dir, message: 'first' });
    const first = await sh(dir, 'rev-parse', 'HEAD');
    write(dir, 'src/pages/index.astro', 'the new words\n');
    await snap.commit(git, { projectPath: dir, message: 'second' });

    const r = await snap.restoreFile(git, {
      projectPath: dir,
      ref: first,
      path: 'src/pages/index.astro',
    });
    check('a file goes back', r.ok === true, JSON.stringify(r));
    check('to what it said then', read(dir, 'src/pages/index.astro') === 'the old words\n');
    // Left as an ordinary uncommitted change, so undoing it is the same as
    // undoing any other edit — no history moved.
    check('as an uncommitted change', (await sh(dir, 'status', '--porcelain')) !== '');
    check('with history untouched', (await sh(dir, 'log', '-1', '--format=%s')) === 'second');
    check('and other files left alone', read(dir, 'other.txt') === 'untouched\n');

    // A file that did not exist then cannot be restored to anything, and
    // writing an empty file would be worse than saying so.
    const missing = await snap.restoreFile(git, {
      projectPath: dir,
      ref: first,
      path: 'src/pages/later.astro',
    });
    check('a file that did not exist yet is refused', missing.ok === false, JSON.stringify(missing));
    check('and explained', /added later/i.test(missing.message || ''), missing.message);
    check('without creating it', !exists(dir, 'src/pages/later.astro'));
  }

  // --- Putting the whole project back --------------------------------------
  {
    const dir = await repo('restoreall');
    cleanup.push(dir);
    write(dir, 'keep.txt', 'v1\n');
    await snap.commit(git, { projectPath: dir, message: 'one' });
    const first = await sh(dir, 'rev-parse', 'HEAD');
    write(dir, 'keep.txt', 'v2\n');
    write(dir, 'added-later.txt', 'this came after\n');
    await snap.commit(git, { projectPath: dir, message: 'two' });

    const r = await snap.restoreProject(git, { projectPath: dir, ref: first });
    check('the project goes back', r.ok === true, JSON.stringify(r));
    check('files go back to what they said', read(dir, 'keep.txt') === 'v1\n', read(dir, 'keep.txt'));
    // THE case. A checkout by pathspec leaves this file behind, and `clean`
    // will not remove it because it is tracked — so "how it was" would be the
    // old project plus a file that did not exist then.
    check(
      'a file added afterwards is gone',
      !exists(dir, 'added-later.txt'),
      'added-later.txt is still on disk — this is the old tree plus a newer file'
    );
    // The branch does not move: going back is itself something to come back
    // from, and moving the branch would silently drop every commit since.
    check('history is not rewritten', (await sh(dir, 'log', '-1', '--format=%s')) === 'two');
    check('and the difference is visible as changes', (await sh(dir, 'status', '--porcelain')) !== '');
  }

  // --- Going back over unsaved work ----------------------------------------
  {
    const dir = await repo('restoredirty');
    cleanup.push(dir);
    write(dir, 'a.txt', 'v1\n');
    await snap.commit(git, { projectPath: dir, message: 'one' });
    const first = await sh(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.txt', 'v2\n');
    await snap.commit(git, { projectPath: dir, message: 'two' });
    write(dir, 'a.txt', 'work in progress\n');

    // With no way to park it, this must refuse rather than write over work
    // that exists nowhere else.
    const { error } = await caught(() => snap.restoreProject(git, { projectPath: dir, ref: first }));
    check('unsaved work with nowhere to go stops it', !!error, error);
    check('and the work is untouched', read(dir, 'a.txt') === 'work in progress\n');

    // Given somewhere to put it, it goes ahead — and says that it parked.
    let parkedCalled = false;
    const r = await snap.restoreProject(git, {
      projectPath: dir,
      ref: first,
      park: async () => {
        parkedCalled = true;
        await sh(dir, 'stash', 'push', '--include-untracked', '-m', 'test-park');
        return true;
      },
    });
    check('with somewhere to park it, it goes ahead', r.ok === true, JSON.stringify(r));
    check('the work was parked first', parkedCalled === true);
    check('and it says so', r.parked === true, JSON.stringify(r));
    check('the project is back', read(dir, 'a.txt') === 'v1\n', read(dir, 'a.txt'));
    // Parked, not destroyed — recoverable is the whole point.
    check('the work is recoverable', (await sh(dir, 'stash', 'list')).includes('test-park'));
  }

  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`git-snapshot: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-snapshot: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

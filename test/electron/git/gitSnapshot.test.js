// Saving a version, and going back to one.
//
//   node test/electron/git/gitSnapshot.test.js
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
const snap = require('#dist/electron/git/gitSnapshot.js');

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

async function repo(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-snap-${name}-`));
  await sh(directory, 'init', '-q', '-b', 'main', '.');
  await sh(directory, 'config', 'core.autocrlf', 'false');
  await sh(directory, 'config', 'user.email', 'tim@example.com');
  await sh(directory, 'config', 'user.name', 'Tim Ricks');
  return directory;
}

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
const exists = (directory, rel) => fs.existsSync(path.join(directory, rel));

const caught = async (callback) => {
  try {
    return { value: await callback(), error: undefined };
  } catch (error) {
    return { value: undefined, error: String(error.message || error) };
  }
};

(async () => {
  const cleanup = [];

  // --- Saving everything (the default, unchanged) --------------------------
  {
    const directory = await repo('all');
    cleanup.push(directory);
    write(directory, 'a.txt', 'one\n');
    write(directory, 'b.txt', 'two\n');
    const result = await snap.commit(git, { projectPath: directory, message: 'everything' });
    check('saving with no picks saves all of it', result.files === undefined, JSON.stringify(result));
    check('and the tree is clean after', (await sh(directory, 'status', '--porcelain')) === '');
    check('with the message given', (await sh(directory, 'log', '-1', '--format=%s')) === 'everything');
  }

  // --- Saving only some ----------------------------------------------------
  {
    const directory = await repo('some');
    cleanup.push(directory);
    write(directory, 'a.txt', 'v1\n');
    write(directory, 'b.txt', 'v1\n');
    write(directory, 'gone.txt', 'v1\n');
    await snap.commit(git, { projectPath: directory, message: 'base' });

    write(directory, 'a.txt', 'v2\n');
    write(directory, 'b.txt', 'v2\n');
    fs.rmSync(path.join(directory, 'gone.txt'));
    write(directory, 'new.txt', 'brand new\n');

    // a.txt (edited) and gone.txt (deleted) — a delete is one of the commonest
    // edits an editor makes, and `git add` on a missing path is an error
    // rather than the obvious thing.
    const result = await snap.commit(git, {
      projectPath: directory,
      message: 'just these two',
      paths: ['a.txt', 'gone.txt'],
    });
    check('it reports how many were saved', result.files === 2, JSON.stringify(result));

    const saved = await sh(directory, 'show', '--name-status', '--format=', 'HEAD');
    check('the edit is in the commit', /M\s+a\.txt/.test(saved), saved);
    check('the deletion is in the commit', /D\s+gone\.txt/.test(saved), saved);
    check('the file that was not picked is not', !/b\.txt/.test(saved), saved);
    check('nor is the new one', !/new\.txt/.test(saved), saved);

    // The half that makes the picker trustworthy: everything unpicked is still
    // sitting there, changed, exactly as it was.
    const left = await sh(directory, 'status', '--porcelain');
    check('the unpicked edit is still uncommitted', /b\.txt/.test(left), left);
    check('and still says what it said', read(directory, 'b.txt') === 'v2\n', read(directory, 'b.txt'));
    check('the unpicked new file is still there', /new\.txt/.test(left), left);
  }

  // --- Something else already staged ---------------------------------------
  {
    const directory = await repo('staged');
    cleanup.push(directory);
    write(directory, 'a.txt', 'v1\n');
    write(directory, 'b.txt', 'v1\n');
    await snap.commit(git, { projectPath: directory, message: 'base' });

    write(directory, 'a.txt', 'v2\n');
    write(directory, 'b.txt', 'v2\n');
    // Staged by something else — another tool, an earlier action. "Only these"
    // has to mean only these, or a file rides along that nobody chose.
    await sh(directory, 'add', 'b.txt');
    await snap.commit(git, { projectPath: directory, message: 'only a', paths: ['a.txt'] });

    const saved = await sh(directory, 'show', '--name-status', '--format=', 'HEAD');
    check('an already-staged file does not ride along', !/b\.txt/.test(saved), saved);
  }

  // --- Picking nothing ------------------------------------------------------
  {
    const directory = await repo('none');
    cleanup.push(directory);
    write(directory, 'a.txt', 'x\n');
    await snap.commit(git, { projectPath: directory, message: 'base' });
    write(directory, 'a.txt', 'y\n');
    const { error } = await caught(() => snap.commit(git, { projectPath: directory, message: 'nothing', paths: [] }));
    // An empty list is a mistake, not "commit everything" — the difference
    // between the two is the whole feature.
    check('picking nothing is refused', !!error, error);
    check('and says so plainly', /pick|choose/i.test(error || ''), error);
    check('and nothing was committed', (await sh(directory, 'log', '-1', '--format=%s')) === 'base');
  }

  // --- Putting one file back ------------------------------------------------
  {
    const directory = await repo('restorefile');
    cleanup.push(directory);
    write(directory, 'src/pages/index.astro', 'the old words\n');
    write(directory, 'other.txt', 'untouched\n');
    await snap.commit(git, { projectPath: directory, message: 'first' });
    const first = await sh(directory, 'rev-parse', 'HEAD');
    write(directory, 'src/pages/index.astro', 'the new words\n');
    await snap.commit(git, { projectPath: directory, message: 'second' });

    const result = await snap.restoreFile(git, {
      projectPath: directory,
      ref: first,
      path: 'src/pages/index.astro',
    });
    check('a file goes back', result.ok === true, JSON.stringify(result));
    check('to what it said then', read(directory, 'src/pages/index.astro') === 'the old words\n');
    // Left as an ordinary uncommitted change, so undoing it is the same as
    // undoing any other edit — no history moved.
    check('as an uncommitted change', (await sh(directory, 'status', '--porcelain')) !== '');
    check('with history untouched', (await sh(directory, 'log', '-1', '--format=%s')) === 'second');
    check('and other files left alone', read(directory, 'other.txt') === 'untouched\n');

    // A file that did not exist then cannot be restored to anything, and
    // writing an empty file would be worse than saying so.
    const missing = await snap.restoreFile(git, {
      projectPath: directory,
      ref: first,
      path: 'src/pages/later.astro',
    });
    check('a file that did not exist yet is refused', missing.ok === false, JSON.stringify(missing));
    check('and explained', /added later/i.test(missing.message || ''), missing.message);
    check('without creating it', !exists(directory, 'src/pages/later.astro'));
  }

  // --- Putting the whole project back --------------------------------------
  {
    const directory = await repo('restoreall');
    cleanup.push(directory);
    write(directory, 'keep.txt', 'v1\n');
    await snap.commit(git, { projectPath: directory, message: 'one' });
    const first = await sh(directory, 'rev-parse', 'HEAD');
    write(directory, 'keep.txt', 'v2\n');
    write(directory, 'added-later.txt', 'this came after\n');
    await snap.commit(git, { projectPath: directory, message: 'two' });

    const result = await snap.restoreProject(git, { projectPath: directory, ref: first });
    check('the project goes back', result.ok === true, JSON.stringify(result));
    check('files go back to what they said', read(directory, 'keep.txt') === 'v1\n', read(directory, 'keep.txt'));
    // THE case. A checkout by pathspec leaves this file behind, and `clean`
    // will not remove it because it is tracked — so "how it was" would be the
    // old project plus a file that did not exist then.
    check(
      'a file added afterwards is gone',
      !exists(directory, 'added-later.txt'),
      'added-later.txt is still on disk — this is the old tree plus a newer file',
    );
    // The branch does not move: going back is itself something to come back
    // from, and moving the branch would silently drop every commit since.
    check('history is not rewritten', (await sh(directory, 'log', '-1', '--format=%s')) === 'two');
    check('and the difference is visible as changes', (await sh(directory, 'status', '--porcelain')) !== '');
  }

  // --- Going back over unsaved work ----------------------------------------
  {
    const directory = await repo('restoredirty');
    cleanup.push(directory);
    write(directory, 'a.txt', 'v1\n');
    await snap.commit(git, { projectPath: directory, message: 'one' });
    const first = await sh(directory, 'rev-parse', 'HEAD');
    write(directory, 'a.txt', 'v2\n');
    await snap.commit(git, { projectPath: directory, message: 'two' });
    write(directory, 'a.txt', 'work in progress\n');

    // With no way to park it, this must refuse rather than write over work
    // that exists nowhere else.
    const { error } = await caught(() => snap.restoreProject(git, { projectPath: directory, ref: first }));
    check('unsaved work with nowhere to go stops it', !!error, error);
    check('and the work is untouched', read(directory, 'a.txt') === 'work in progress\n');

    // Given somewhere to put it, it goes ahead — and says that it parked.
    let parkedCalled = false;
    const result = await snap.restoreProject(git, {
      projectPath: directory,
      ref: first,
      park: async () => {
        parkedCalled = true;
        await sh(directory, 'stash', 'push', '--include-untracked', '-m', 'test-park');
        return true;
      },
    });
    check('with somewhere to park it, it goes ahead', result.ok === true, JSON.stringify(result));
    check('the work was parked first', parkedCalled === true);
    check('and it says so', result.parked === true, JSON.stringify(result));
    check('the project is back', read(directory, 'a.txt') === 'v1\n', read(directory, 'a.txt'));
    // Parked, not destroyed — recoverable is the whole point.
    check('the work is recoverable', (await sh(directory, 'stash', 'list')).includes('test-park'));
  }

  for (const directory of cleanup) {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`git-snapshot: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-snapshot: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

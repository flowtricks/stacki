// Goal: the branch publishing is expected to send is the remote's own default when it has one, else main or master, else unknown,
// so a repository whose default is `develop` is never told it is on the wrong branch, and a project with no remote falls back to
// the trunk. Branch names are data: a name that looks like shell syntax comes back whole and runs nothing.
// Methodology: real throwaway repositories and the real git, with origin/HEAD set by hand (no network needed). Negative space: no
// origin/HEAD, a remote that is not called origin, an over-long name, an empty name, and a hostile name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readDefaultBranch } = require('#dist/electron/git/gitBranches.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });

async function repo(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-default-branch-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await git(directory, ['init', '-q', '-b', 'main', '.']);
  return directory;
}

const pointOriginAt = (directory, name) => git(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${name}`]);

test('with no remote the trunk is the answer, and with no trunk there is none', async (context) => {
  const directory = await repo(context);
  assert.equal(await readDefaultBranch(git, directory, 'main'), 'main');
  assert.equal(await readDefaultBranch(git, directory, undefined), undefined);
});

test("the remote's default wins over the trunk", async (context) => {
  const directory = await repo(context);
  await pointOriginAt(directory, 'develop');
  assert.equal(await readDefaultBranch(git, directory, 'main'), 'develop');
  assert.equal(await readDefaultBranch(git, directory, undefined), 'develop');
});

test('a branch name with a slash keeps it', async (context) => {
  const directory = await repo(context);
  await pointOriginAt(directory, 'release/2026');
  assert.equal(await readDefaultBranch(git, directory, 'main'), 'release/2026');
});

test('a hostile name comes back as data and runs nothing', async (context) => {
  const directory = await repo(context);
  // Git refuses spaces in a name, so the shell syntax uses ${IFS}; run through a shell this would create both files.
  const hostile = 'x$(touch${IFS}pwned);`touch${IFS}pwned2`';
  await pointOriginAt(directory, hostile);
  assert.equal(await readDefaultBranch(git, directory, 'main'), hostile);
  assert.equal(fs.existsSync(path.join(directory, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(directory, 'pwned2')), false);
});

test('a default that is not origin, or is absurdly long, is ignored for the trunk', async (context) => {
  const directory = await repo(context);
  await git(directory, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main']);
  assert.equal(await readDefaultBranch(git, directory, 'master'), 'master');
  await pointOriginAt(directory, 'a'.repeat(300));
  assert.equal(await readDefaultBranch(git, directory, 'main'), 'main');
});

test('a failing git is the same as no answer', async () => {
  const failing = async () => {
    throw new Error('not a repository');
  };
  assert.equal(await readDefaultBranch(failing, '/nowhere', 'main'), 'main');
  assert.equal(await readDefaultBranch(failing, '/nowhere', undefined), undefined);
});

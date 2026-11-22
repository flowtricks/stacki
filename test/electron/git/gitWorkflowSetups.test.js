// Goal: the Git panel's commit, branch and status paths work however a project's repository happens to be set up.
// Method: build throwaway repositories in the temp folder for each odd setup (no commits yet, detached HEAD, a project inside a
// larger repository, paths with spaces, accents, brackets and leading dashes, a failing hook, a missing identity, an unfinished
// cherry-pick, hundreds of picked files) and run the production modules against them through the production git runner, so the
// environment it sets (LC_ALL=C, no prompts) and the way it words failures are exercised too. Each refusal is checked as well as
// each success: the negative space (refused names, refused refs, work left where it was) is the point.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { git, setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
const { commit, restoreFile, restoreProject } = require('#dist/electron/git/gitSnapshot.js');
const history = require('#dist/electron/git/gitHistory.js');
const state = require('#dist/electron/git/gitState.js');
const { switchBranch, mergeBranch, deleteBranch } = require('#dist/electron/git/gitBranches.js');
const { explainGitFailure } = require('#dist/electron/git/gitFailure.js');
const { parkBranch, unparkBranch, currentBranch } = require('#dist/electron/git/gitParking.js');

setToolPathHome(os.homedir());
const execute = promisify(execFile);
const plain = async (cwd, args) => (await execute('git', args, { cwd, maxBuffer: 1024 * 1024 })).stdout.trim();

async function repository(context, { commits = true, identity = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-setup-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await plain(directory, ['init', '--initial-branch=main']);
  if (identity) {
    await plain(directory, ['config', 'user.name', 'Test']);
    await plain(directory, ['config', 'user.email', 'test@example.com']);
  }
  await plain(directory, ['config', 'commit.gpgsign', 'false']);
  await plain(directory, ['config', 'core.autocrlf', 'false']);
  if (commits) {
    await write(directory, 'base.txt', 'base\n');
    await plain(directory, ['add', '-A']);
    await plain(directory, ['commit', '-m', 'base']);
  }
  return directory;
}

async function write(directory, relative, body) {
  const target = path.join(directory, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

const messageOf = (error) => (error && error.messageRef ? error.messageRef.key : String(error && error.message));
const refused = async (work, key) => {
  await assert.rejects(work, (error) => {
    assert.equal(messageOf(error), key);
    return true;
  });
};

test('status lists names git would quote, with their real spelling and nothing hidden in untracked folders', async (context) => {
  const directory = await repository(context);
  for (const name of ['a b.txt', 'café.txt', '[slug].astro', '-dash.txt', 'deep/er/file.txt']) {
    await write(directory, name, 'x\n');
  }
  await plain(directory, ['mv', 'base.txt', 'renamed base.txt']);
  const files = await history.status(git, { projectPath: directory });
  const paths = files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['-dash.txt', 'a b.txt', 'café.txt', 'deep/er/file.txt', 'renamed base.txt', '[slug].astro'].sort());
  const renamed = files.find((file) => file.path === 'renamed base.txt');
  assert.equal(renamed.from, 'base.txt');
  assert.equal(renamed.staged, true);
  assert.equal(files.find((file) => file.path === 'café.txt').untracked, true);
});

test('a project inside a larger repository sees project-relative paths and only its own changes', async (context) => {
  const root = await repository(context);
  await write(root, 'site/src/pages/index.astro', 'one\n');
  await write(root, 'other/readme.md', 'one\n');
  await plain(root, ['add', '-A']);
  await plain(root, ['commit', '-m', 'two projects']);
  const site = path.join(root, 'site');
  await write(root, 'site/src/pages/index.astro', 'two\n');
  await write(root, 'other/readme.md', 'two\n');
  assert.equal(await state.projectPrefix(git, site), 'site/');
  const files = await history.status(git, { projectPath: site });
  assert.deepEqual(
    files.map((file) => file.path),
    ['src/pages/index.astro'],
  );
  // The picker's own path round-trips into a commit, which a root-relative path could not.
  await commit(git, { projectPath: site, message: 'site only', paths: ['src/pages/index.astro'] });
  assert.match(await plain(root, ['status', '--porcelain']), /other\/readme\.md/);
  // Saving everything saves the project folder, not its sibling.
  await write(root, 'site/src/pages/index.astro', 'three\n');
  await commit(git, { projectPath: site, message: 'site all' });
  assert.match(await plain(root, ['status', '--porcelain']), /other\/readme\.md/);
  assert.equal(await plain(root, ['log', '-1', '--format=%s']), 'site all');
  const log = await history.log(git, { projectPath: site, withFiles: true });
  assert.deepEqual(
    log.commits[0].files.map((file) => file.path),
    ['src/pages/index.astro'],
  );
});

test('a partial commit takes literal names: brackets and globs are file names, not patterns', async (context) => {
  const directory = await repository(context);
  await write(directory, '[ab].txt', 'bracket\n');
  await write(directory, 'a.txt', 'a\n');
  await write(directory, 'sp ace.txt', 'space\n');
  await write(directory, '-lead.txt', 'dash\n');
  await commit(git, { projectPath: directory, message: 'literal', paths: ['[ab].txt', 'sp ace.txt', '-lead.txt'] });
  const committed = (await plain(directory, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort();
  assert.deepEqual(committed, ['-lead.txt', '[ab].txt', 'sp ace.txt'].sort());
  assert.match(await plain(directory, ['status', '--porcelain']), /\?\? a\.txt/);
});

test('hundreds of picked files go through a pathspec file and leave the rest alone', async (context) => {
  const directory = await repository(context);
  const picked = [];
  for (let index = 0; index < 250; index++) {
    const name = `many/file ${index}.txt`;
    picked.push(name);
    await write(directory, name, `${index}\n`);
  }
  await write(directory, 'left-alone.txt', 'x\n');
  const result = await commit(git, { projectPath: directory, message: 'many', paths: picked });
  assert.equal(result.files, 250);
  assert.equal((await plain(directory, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').length, 250);
  assert.match(await plain(directory, ['status', '--porcelain']), /\?\? left-alone\.txt/);
});

test('commit messages: unicode survives, blank falls back, oversized and empty picks are refused', async (context) => {
  const directory = await repository(context);
  await write(directory, 'one.txt', '1\n');
  await commit(git, { projectPath: directory, message: '  日本語 ✓ café – émoji 🚀  ' });
  assert.equal(await plain(directory, ['log', '-1', '--format=%s']), '日本語 ✓ café – émoji 🚀');
  await write(directory, 'two.txt', '2\n');
  await commit(git, { projectPath: directory, message: '   ' });
  assert.equal(await plain(directory, ['log', '-1', '--format=%s']), 'Update from Stacki');
  await write(directory, 'three.txt', '3\n');
  await refused(() => commit(git, { projectPath: directory, message: 'x'.repeat(60_000) }), 'git.error.messageTooLong');
  await refused(() => commit(git, { projectPath: directory, message: 'm', paths: [] }), 'git.error.commitNothingPicked');
  assert.match(await plain(directory, ['status', '--porcelain']), /three\.txt/);
});

test('the first commit works, whole or picked, before any commit exists', async (context) => {
  const whole = await repository(context, { commits: false });
  await write(whole, 'a.txt', 'a\n');
  await commit(git, { projectPath: whole, message: 'first' });
  assert.equal(await plain(whole, ['log', '--format=%s']), 'first');
  const picked = await repository(context, { commits: false });
  await write(picked, 'a.txt', 'a\n');
  await write(picked, 'b.txt', 'b\n');
  await commit(git, { projectPath: picked, message: 'first', paths: ['a.txt'] });
  assert.equal(await plain(picked, ['show', '--name-only', '--format=', 'HEAD']), 'a.txt');
});

test('nothing to save, a missing identity and a failing hook each come back as something to act on', async (context) => {
  const clean = await repository(context);
  await assert.rejects(
    () => commit(git, { projectPath: clean, message: 'nothing' }),
    (error) => {
      assert.equal(messageOf(explainGitFailure(error)), 'git.error.nothingToCommit');
      return true;
    },
  );

  const anonymous = await repository(context, { identity: false });
  await plain(anonymous, ['config', 'user.useConfigOnly', 'true']);
  await plain(anonymous, ['config', 'user.name', '']);
  await write(anonymous, 'a.txt', 'a\n');
  const previous = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  context.after(() => {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', previous.global],
      ['GIT_CONFIG_NOSYSTEM', previous.system],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  await assert.rejects(
    () => commit(git, { projectPath: anonymous, message: 'who' }),
    (error) => {
      assert.equal(messageOf(explainGitFailure(error)), 'git.error.identityMissing');
      return true;
    },
  );

  const hooked = await repository(context);
  const hook = path.join(hooked, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\necho "LINT FAILED: fix index.astro"\nexit 1\n', { mode: 0o755 });
  await write(hooked, 'a.txt', 'a\n');
  await assert.rejects(
    () => commit(git, { projectPath: hooked, message: 'hooked', paths: ['a.txt'] }),
    (error) => {
      // The hook's own words reach the person; the command line, with the whole message in it, does not.
      assert.match(error.message, /LINT FAILED: fix index\.astro/);
      assert.doesNotMatch(error.message, /Command failed|hooked/);
      return true;
    },
  );
});

test('an unfinished cherry-pick is never committed over, and no branch switch or merge starts on top of it', async (context) => {
  const directory = await repository(context);
  await plain(directory, ['switch', '-c', 'other']);
  await write(directory, 'base.txt', 'other side\n');
  await plain(directory, ['commit', '-am', 'other']);
  await plain(directory, ['switch', 'main']);
  await write(directory, 'base.txt', 'main side\n');
  await plain(directory, ['commit', '-am', 'main']);
  await assert.rejects(() => plain(directory, ['cherry-pick', 'other']));
  assert.equal(await state.unfinishedOperation(git, directory), 'cherry-pick');
  await refused(() => commit(git, { projectPath: directory, message: 'mid' }), 'git.error.operationInProgress');
  await refused(() => mergeBranch(git, { projectPath: directory, branch: 'other' }), 'git.error.operationInProgress');
  await refused(
    () => switchBranch(git, { projectPath: directory, branch: 'other', park: async () => false, unpark: async () => undefined }),
    'git.error.operationInProgress',
  );
  await refused(() => restoreProject(git, { projectPath: directory, ref: 'HEAD' }), 'git.error.operationInProgress');
  await plain(directory, ['cherry-pick', '--abort']);
  assert.equal(await state.unfinishedOperation(git, directory), undefined);
});

test('head state: a branch with no commits, a normal branch and a detached HEAD are told apart', async (context) => {
  const unborn = await repository(context, { commits: false });
  assert.deepEqual(await state.readHead(git, unborn), { branch: 'main', born: false });
  assert.equal(await currentBranch(unborn), undefined);
  assert.equal(await parkBranch(unborn, 'main'), false);
  const born = await repository(context);
  assert.deepEqual(await state.readHead(git, born), { branch: 'main', born: true });
  await plain(born, ['switch', '--detach']);
  assert.deepEqual(await state.readHead(git, born), { branch: undefined, born: true });
  assert.equal(await currentBranch(born), 'HEAD');
});

test('branch names: git decides, and nothing option-like or clashing reaches a command', async (context) => {
  const directory = await repository(context);
  await plain(directory, ['branch', 'feature']);
  for (const accepted of ['new-thing', 'área/ñandú', 'release/1.2', 'ünï']) {
    await state.requireValidBranchName(git, directory, accepted);
  }
  for (const rejected of ['', '-x', '--abort', 'a b', 'a..b', 'x.lock', 'a/.b', 'end.', '@', 'a~1', 'a:b', ' padded', 'a\\b', 'HEAD']) {
    await refused(() => state.requireValidBranchName(git, directory, rejected), 'git.error.branchNameInvalid');
  }
  assert.equal(await state.branchExists(git, directory, 'feature'), true);
  assert.equal(await state.branchExists(git, directory, 'feat'), false);
});

test('creating a branch: a duplicate or invalid name leaves the work where it was, an unborn repository can still branch', async (context) => {
  const directory = await repository(context);
  await plain(directory, ['branch', 'feature']);
  await write(directory, 'wip.txt', 'work in progress\n');
  const parking = { park: (branch) => parkBranch(directory, branch), unpark: (branch) => unparkBranch(directory, branch) };
  await refused(() => switchBranch(git, { projectPath: directory, branch: 'feature', create: true, ...parking }), 'git.error.branchExists');
  await refused(() => switchBranch(git, { projectPath: directory, branch: '--force', create: true, ...parking }), 'git.error.branchNameInvalid');
  await refused(() => switchBranch(git, { projectPath: directory, branch: '--abort', ...parking }), 'git.error.refInvalid');
  assert.equal(await plain(directory, ['stash', 'list']), '');
  assert.equal(await fs.readFile(path.join(directory, 'wip.txt'), 'utf8'), 'work in progress\n');
  // A name that would need "feature" to be a folder too is git's refusal, reported as the clash it is.
  await assert.rejects(
    () => switchBranch(git, { projectPath: directory, branch: 'feature/inner', create: true, ...parking }),
    (error) => {
      assert.equal(messageOf(explainGitFailure(error)), 'git.error.branchNameConflict');
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(directory, 'wip.txt'), 'utf8'), 'work in progress\n');

  const unborn = await repository(context, { commits: false });
  const result = await switchBranch(git, { projectPath: unborn, branch: 'start-here', create: true, park: async () => false, unpark: async () => undefined });
  assert.equal(result.ok, true);
  assert.equal(await plain(unborn, ['symbolic-ref', '--short', 'HEAD']), 'start-here');
});

test('deleting and merging refuse an option-shaped name instead of passing it to git', async (context) => {
  const directory = await repository(context);
  await refused(() => deleteBranch(git, { projectPath: directory, branch: '--help' }), 'git.error.refInvalid');
  await refused(() => mergeBranch(git, { projectPath: directory, branch: '--abort' }), 'git.error.refInvalid');
});

test('history: a ref cannot be an option, and accented names are listed as written', async (context) => {
  const directory = await repository(context);
  await write(directory, 'café/ñ.txt', 'x\n');
  await plain(directory, ['add', '-A']);
  await plain(directory, ['commit', '-m', 'accents']);
  const target = path.join(directory, 'written-by-log');
  await refused(() => history.log(git, { projectPath: directory, ref: `--output=${target}` }), 'git.error.refInvalid');
  await assert.rejects(() => fs.stat(target));
  const log = await history.log(git, { projectPath: directory, withFiles: true, limit: 5 });
  assert.equal(log.commits[0].files[0].path, 'café/ñ.txt');
  // A page size past the limit, or a negative one, is clamped rather than handed to git.
  const clamped = await history.log(git, { projectPath: directory, limit: -4, skip: -9 });
  assert.equal(clamped.commits.length, 1);
});

test('restoring: a ref cannot be an option, and a project inside a repository restores only its own folder', async (context) => {
  const root = await repository(context);
  await write(root, 'site/page.txt', 'firstVersion\n');
  await write(root, 'other/page.txt', 'firstVersion\n');
  await plain(root, ['add', '-A']);
  await plain(root, ['commit', '-m', 'firstVersion']);
  const firstVersion = await plain(root, ['rev-parse', 'HEAD']);
  await write(root, 'site/page.txt', 'v2\n');
  await write(root, 'site/added-later.txt', 'new\n');
  await write(root, 'other/page.txt', 'v2\n');
  await plain(root, ['add', '-A']);
  await plain(root, ['commit', '-m', 'v2']);
  const site = path.join(root, 'site');
  await refused(() => restoreFile(git, { projectPath: site, ref: '--help', path: 'page.txt' }), 'git.error.refInvalid');
  await refused(() => restoreProject(git, { projectPath: site, ref: '-x' }), 'git.error.refInvalid');
  const file = await restoreFile(git, { projectPath: site, ref: firstVersion, path: 'page.txt' });
  assert.equal(file.ok, true);
  assert.equal(await fs.readFile(path.join(site, 'page.txt'), 'utf8'), 'firstVersion\n');
  await plain(root, ['checkout', 'HEAD', '--', '.']);
  await restoreProject(git, { projectPath: site, ref: firstVersion, park: async () => false });
  assert.equal(await fs.readFile(path.join(site, 'page.txt'), 'utf8'), 'firstVersion\n');
  await assert.rejects(() => fs.stat(path.join(site, 'added-later.txt')));
  assert.equal(await fs.readFile(path.join(root, 'other', 'page.txt'), 'utf8'), 'v2\n');
});

test('the git runner speaks English, never prompts and never opens an editor', async (context) => {
  const directory = await repository(context);
  const { stdout } = await git(directory, ['-c', 'alias.showenv=!env', 'showenv']);
  for (const line of ['LC_ALL=C', 'GIT_TERMINAL_PROMPT=0', 'GIT_EDITOR=true', 'GIT_OPTIONAL_LOCKS=0']) {
    assert.ok(stdout.split('\n').includes(line), `${line} is set for git`);
  }
});

test('failures are explained: each recognised wording becomes its sentence, and anything else keeps git’s own words', () => {
  const failing = (stderr, extra = {}) => Object.assign(new Error('Command failed: git x'), { stderr, stdout: '', ...extra });
  const cases = [
    ["fatal: Unable to create '/p/.git/index.lock': File exists.", 'git.error.locked'],
    ["fatal: detected dubious ownership in repository at '/p'", 'git.error.unsafeDirectory'],
    ['fatal: Authentication failed for https://github.com/a/b.git/', 'git.error.authFailed'],
    ['fatal: could not read Username for https://github.com: terminal prompts disabled', 'git.error.authFailed'],
    ["fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", 'git.error.offline'],
    ['! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs', 'git.error.pushRejected'],
    ["fatal: 'origin' does not appear to be a git repository", 'git.error.noRemote'],
    ['error: gpg failed to sign the data', 'git.error.signingFailed'],
    ['*** Please tell me who you are.', 'git.error.identityMissing'],
    ["error: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create 'refs/heads/a/b'", 'git.error.branchNameConflict'],
  ];
  for (const [stderr, key] of cases) {
    assert.equal(messageOf(explainGitFailure(failing(stderr))), key, stderr);
  }
  assert.equal(messageOf(explainGitFailure(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))), 'git.error.notInstalled');
  assert.equal(messageOf(explainGitFailure(failing('', { killed: true }))), 'git.error.timedOut');
  assert.equal(messageOf(explainGitFailure(Object.assign(new Error('big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))), 'git.error.outputTooLarge');
  const unknown = failing('fatal: something nobody planned for');
  assert.equal(explainGitFailure(unknown), unknown);
  const ours = Object.assign(new Error('ours'), { messageRef: { key: 'git.error.mergeSelf' } });
  assert.equal(explainGitFailure(ours), ours);
});

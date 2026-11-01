// Goal: pulling updates the requested branch without discarding local work.
// Methodology: use a local bare remote and two clones to exercise real fetches,
// fast-forwards, conflicts, dirty files, missing branches, and branch changes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pullBranch, readIncomingCommits } = require('#dist/electron/git/gitPull.js');
const { resolveMerge } = require('#dist/electron/git/gitBranches.js');
const execute = promisify(execFile);
const git = (cwd, args) =>
  execute('git', args, {
    cwd,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-pull-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const reader = path.join(root, 'reader');
  await git(root, ['init', '--bare', '--initial-branch=main', remote]);
  await git(root, ['clone', remote, author]);
  await identity(author);
  await commit(author, 'base');
  await git(author, ['push', 'origin', 'main']);
  await git(root, ['clone', remote, reader]);
  await identity(reader);
  return { author, reader, remote };
}

async function identity(directory) {
  await git(directory, ['config', 'user.name', 'Test']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'commit.gpgsign', 'false']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
}

async function commit(directory, content) {
  await fs.writeFile(path.join(directory, 'page.txt'), `${content}\n`);
  await git(directory, ['add', 'page.txt']);
  await git(directory, ['commit', '--message', content]);
}

test('Pull fetches new commits, preserves unrelated edits and reports no-op', async (context) => {
  const { author, reader } = await fixture(context);
  await commit(author, 'remote change');
  await git(author, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(reader, 'local.txt'), 'unsaved project work');
  await git(reader, ['branch', '--unset-upstream']);
  const result = await pullBranch(git, { projectPath: reader, branch: 'main' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'remote change\n');
  assert.equal(await fs.readFile(path.join(reader, 'local.txt'), 'utf8'), 'unsaved project work');
  assert.equal((await pullBranch(git, { projectPath: reader, branch: 'main' })).changed, false);
});

test('Pull preserves overlapping local edits and unwinds committed conflicts', async (context) => {
  const { author, reader } = await fixture(context);
  await commit(author, 'remote change');
  await git(author, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(reader, 'page.txt'), 'my edit\n');
  const dirty = await pullBranch(git, { projectPath: reader, branch: 'main' });
  assert.equal(dirty.dirty, true);
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'my edit\n');
  await commit(reader, 'local commit');
  const conflict = await pullBranch(git, { projectPath: reader, branch: 'main' });
  assert.equal(conflict.conflicted, true);
  assert.equal(conflict.files[0].path, 'page.txt');
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'local commit\n');
  assert.equal((await git(reader, ['status', '--porcelain'])).stdout, '');
  const resolved = await resolveMerge(git, {
    projectPath: reader,
    branch: conflict.branch,
    choices: { 'page.txt': 'theirs' },
  });
  assert.equal(resolved.ok, true);
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'remote change\n');
});

test('Pull fails without merging stale refs or a different local branch', async (context) => {
  const { author, reader, remote } = await fixture(context);
  await commit(author, 'remote change');
  await git(author, ['push', 'origin', 'main']);
  await git(reader, ['fetch', 'origin']);
  await git(remote, ['update-ref', '-d', 'refs/heads/main']);
  await assert.rejects(pullBranch(git, { projectPath: reader, branch: 'main' }));
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'base\n');
  await git(author, ['push', 'origin', 'main']);
  const switchDuringFetch = async (directory, args) => {
    const result = await git(directory, args);
    if (args[0] === 'fetch') {
      await git(directory, ['switch', '--create', 'other']);
    }
    return result;
  };
  await assert.rejects(pullBranch(switchDuringFetch, { projectPath: reader, branch: 'main' }), /branch changed/);
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'base\n');
  await assert.rejects(pullBranch(git, { projectPath: reader, branch: '../invalid' }));
});

test('Detection counts commits without touching refs or files', async (context) => {
  const { author, reader } = await fixture(context);
  const options = { projectPath: reader, branch: 'main' };
  assert.equal(await readIncomingCommits(git, options), 0);
  const trackingBefore = (await git(reader, ['rev-parse', 'origin/main'])).stdout;
  await fs.writeFile(path.join(reader, '.git', 'FETCH_HEAD'), 'preserve foreground fetch');
  await fs.writeFile(path.join(reader, 'page.txt'), 'local edits\n');
  await commit(author, 'first incoming');
  await commit(author, 'second incoming');
  await git(author, ['push', 'origin', 'main']);
  assert.equal(await readIncomingCommits(git, options), 2);
  assert.equal((await git(reader, ['rev-parse', 'origin/main'])).stdout, trackingBefore);
  assert.equal(await fs.readFile(path.join(reader, '.git', 'FETCH_HEAD'), 'utf8'), 'preserve foreground fetch');
  assert.equal(await fs.readFile(path.join(reader, 'page.txt'), 'utf8'), 'local edits\n');
  const calls = [];
  const observedGit = (directory, args) => {
    calls.push(args);
    return git(directory, args);
  };
  assert.equal(await readIncomingCommits(observedGit, options), 2);
  assert.equal(calls.filter(([command]) => command === 'fetch').length, 0);
  await git(reader, ['restore', 'page.txt']);
  await pullBranch(git, options);
  assert.equal(await readIncomingCommits(git, options), 0);
  await commit(reader, 'ahead only');
  assert.equal(await readIncomingCommits(git, options), 0);
  await git(reader, ['switch', '--create', 'unpublished']);
  assert.equal(await readIncomingCommits(git, { projectPath: reader, branch: 'unpublished' }), 0);
  await git(reader, ['remote', 'set-url', 'origin', path.join(reader, 'missing.git')]);
  await assert.rejects(readIncomingCommits(git, { projectPath: reader, branch: 'unpublished' }));
});

test('Incoming discovery rejects malformed remote refs and commit counts', async () => {
  const options = { projectPath: '/project', branch: 'main' };
  const remote = `${'a'.repeat(40)}\trefs/heads/main`;
  const replies = (advertised, count) => async (_directory, args) => {
    switch (args[0]) {
      case 'symbolic-ref':
        return { stdout: 'main\n' };
      case 'ls-remote':
        return { stdout: advertised };
      case 'rev-list':
        return { stdout: count };
      default:
        return { stdout: '' };
    }
  };
  for (const advertised of ['bad\trefs/heads/main', `${'a'.repeat(40)}\trefs/heads/other`, `${remote}\n${remote}`]) {
    await assert.rejects(readIncomingCommits(replies(advertised, '0'), options));
  }
  for (const count of ['-1', '1.5', 'unknown', '9007199254740992']) {
    await assert.rejects(readIncomingCommits(replies(remote, count), options));
  }
  assert.equal(await readIncomingCommits(replies(remote, '2'), options), 2);
});

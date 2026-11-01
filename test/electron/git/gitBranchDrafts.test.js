// Goal: previewing another branch never carries unfinished edits across.
// Method: switch real temporary repositories using the production stash helpers;
// verify file content, staging, branch history, failures, and independent drafts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { switchBranch } = require('#dist/electron/git/gitBranches.js');
const { parkBranch, unparkBranch } = require('#dist/electron/git/gitParking.js');
const { ensureExcluded } = require('#dist/electron/lib/projectExclusions.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());
const execute = promisify(execFile);
const git = (cwd, args) => execute('git', args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 });
const output = async (cwd, args) => (await git(cwd, args)).stdout.trim();
const parking = (projectPath) => ({
  park: (branch) => parkBranch(projectPath, branch),
  unpark: (branch) => unparkBranch(projectPath, branch),
});

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-branch-drafts-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await git(directory, ['init', '--initial-branch=main']);
  await git(directory, ['config', 'user.name', 'Test']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'commit.gpgsign', 'false']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(directory, 'page.txt'), 'committed\n');
  await git(directory, ['add', 'page.txt']);
  await git(directory, ['commit', '--message', 'base']);
  await git(directory, ['switch', '--create', 'feature']);
  return directory;
}

async function checkout(directory, branch) {
  const result = await switchBranch(git, {
    projectPath: directory,
    branch,
    ...parking(directory),
  });
  assert.equal(result.ok, true);
  const restored = await unparkBranch(directory, branch);
  assert.equal(restored.error, undefined);
  return { ...result, ...restored };
}

test('Staged, unstaged and new files stay on feature and restore', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  const draft = path.join(directory, 'draft.txt');
  await fs.writeFile(page, 'staged\n');
  await git(directory, ['add', 'page.txt']);
  await fs.writeFile(page, 'unstaged\n');
  await fs.writeFile(draft, 'new file\n');
  const history = await output(directory, ['rev-parse', 'feature', 'main']);
  const before = await output(directory, ['status', '--porcelain']);
  const switched = await checkout(directory, 'main');
  assert.equal(switched.parked, true);
  assert.equal(await output(directory, ['status', '--porcelain']), '');
  assert.equal(await fs.readFile(page, 'utf8'), 'committed\n');
  await assert.rejects(fs.readFile(draft), { code: 'ENOENT' });
  assert.equal(await output(directory, ['rev-parse', 'feature', 'main']), history);
  const returned = await checkout(directory, 'feature');
  assert.equal(returned.restored, true);
  assert.equal(await fs.readFile(page, 'utf8'), 'unstaged\n');
  assert.equal(await fs.readFile(draft, 'utf8'), 'new file\n');
  assert.equal(await output(directory, ['show', ':page.txt']), 'staged');
  assert.equal(await output(directory, ['status', '--porcelain']), before);
  assert.equal(await output(directory, ['stash', 'list']), '');
  await checkout(directory, 'main');
  assert.equal(await output(directory, ['status', '--porcelain']), '');
  await checkout(directory, 'feature');
  assert.equal(await fs.readFile(page, 'utf8'), 'unstaged\n');
});

test('Clean and reverted files switch without a stash or commit', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'temporary edit\n');
  await fs.writeFile(page, 'committed\n');
  const history = await output(directory, ['rev-parse', 'feature', 'main']);
  assert.equal((await checkout(directory, 'main')).parked, false);
  assert.equal((await checkout(directory, 'feature')).parked, false);
  assert.equal(await output(directory, ['stash', 'list']), '');
  assert.equal(await output(directory, ['rev-parse', 'feature', 'main']), history);
});

test('Generated caches survive branches with different ignore rules', async (context) => {
  const directory = await fixture(context);
  await fs.writeFile(path.join(directory, '.gitignore'), '.cache/fern/\n');
  await git(directory, ['add', '.gitignore']);
  await git(directory, ['commit', '--message', 'Ignore generated Fern cache']);
  const cache = path.join(directory, '.cache/fern');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'private-source.txt'), 'cached dependency\n');
  await fs.mkdir(path.join(directory, '.stacki'));
  await fs.writeFile(path.join(directory, '.stacki/guide.json'), '{"columns":12}\n');
  await checkout(directory, 'main');
  assert.equal(await output(directory, ['status', '--porcelain']), '');
  assert.equal(await fs.readFile(path.join(cache, 'private-source.txt'), 'utf8'), 'cached dependency\n');
  const returned = await checkout(directory, 'feature');
  assert.equal(returned.parked, false, 'Generated files are not unfinished main edits');
  assert.equal(returned.restored, true);
  assert.equal(await fs.readFile(path.join(cache, 'private-source.txt'), 'utf8'), 'cached dependency\n');
  assert.equal(await fs.readFile(path.join(directory, '.stacki/guide.json'), 'utf8'), '{"columns":12}\n');
  assert.equal(await output(directory, ['stash', 'list']), '');
  await git(directory, ['add', '--force', '.cache/fern/private-source.txt']);
  await fs.writeFile(path.join(cache, 'private-source.txt'), 'tracked edit\n');
  await checkout(directory, 'main');
  await checkout(directory, 'feature');
  assert.equal(await fs.readFile(path.join(cache, 'private-source.txt'), 'utf8'), 'tracked edit\n');
});

test('Branch drafts stay separate from each other and manual stashes', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'manual stash\n');
  await git(directory, ['stash', 'push', '--message', 'my manual stash']);
  const manual = await output(directory, ['stash', 'list', '--format=%H']);
  await fs.writeFile(page, 'feature draft\n');
  await checkout(directory, 'main');
  await fs.writeFile(page, 'main draft\n');
  await checkout(directory, 'feature');
  assert.equal(await fs.readFile(page, 'utf8'), 'feature draft\n');
  await checkout(directory, 'main');
  assert.equal(await fs.readFile(page, 'utf8'), 'main draft\n');
  assert.ok((await output(directory, ['stash', 'list', '--format=%H'])).includes(manual));
});

test('Inherited exclusions match literal paths and preserve authored metadata', async (context) => {
  const directory = await fixture(context);
  const ignoredPaths = ['cache [a]/', 'private key.txt', '#cache/'];
  assert.equal(ensureExcluded(directory, { ignoredPaths }), true);
  const file = path.join(directory, '.git/info/exclude');
  const first = await fs.readFile(file, 'utf8');
  assert.equal(ensureExcluded(directory, { ignoredPaths }), true);
  assert.equal(await fs.readFile(file, 'utf8'), first, 'Repeated switching cannot grow exclusions');
  for (const entry of ['cache [a]/data', 'private key.txt', '#cache/data']) {
    assert.equal(await output(directory, ['check-ignore', entry]), entry);
  }
  for (const entry of ['cache a/data', 'nested/private key.txt', '.stacki/guide.json']) {
    await assert.rejects(git(directory, ['check-ignore', entry]));
  }
  for (const entry of ['', '/outside', '../outside', 'line\nbreak', 'x'.repeat(4097)]) {
    assert.throws(() => ensureExcluded(directory, { ignoredPaths: [entry] }));
  }
  assert.equal(ensureExcluded(directory, { ignoredPaths: Array(4097).fill('cache/') }), false);
  await fs.writeFile(file, 'x'.repeat(1_000_001));
  assert.equal(ensureExcluded(directory, { ignoredPaths }), false);
  assert.equal((await fs.stat(file)).size, 1_000_001);
});

test('Failed switch restores the original edits and staging', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'staged draft\n');
  await git(directory, ['add', 'page.txt']);
  await fs.writeFile(page, 'unstaged draft\n');
  await assert.rejects(
    switchBranch(git, {
      projectPath: directory,
      branch: 'missing',
      ...parking(directory),
    }),
  );
  assert.equal(await output(directory, ['branch', '--show-current']), 'feature');
  assert.equal(await fs.readFile(page, 'utf8'), 'unstaged draft\n');
  assert.equal(await output(directory, ['show', ':page.txt']), 'staged draft');
  assert.equal(await output(directory, ['stash', 'list']), '');
});

test('Parking failure stops switching; same-branch checkout does not park', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'draft\n');
  const unavailable = async () => {
    throw new Error('Cannot save draft');
  };
  await assert.rejects(
    switchBranch(git, {
      projectPath: directory,
      branch: 'main',
      ...parking(directory),
      park: unavailable,
    }),
    /Cannot save draft/,
  );
  const unchanged = await switchBranch(git, {
    projectPath: directory,
    branch: 'feature',
    ...parking(directory),
    park: unavailable,
  });
  assert.equal(unchanged.parked, false);
  assert.equal(await output(directory, ['branch', '--show-current']), 'feature');
  assert.equal(await fs.readFile(page, 'utf8'), 'draft\n');
});

test('Restoration refuses to overwrite newly introduced local edits', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'parked draft\n');
  await parkBranch(directory, 'feature');
  await fs.writeFile(page, 'external edit\n');
  const result = await unparkBranch(directory, 'feature');
  assert.equal(result.restored, false);
  assert.match(result.error, /local changes/);
  assert.equal(await fs.readFile(page, 'utf8'), 'external edit\n');
  assert.match(await output(directory, ['stash', 'list']), /stacki:park:feature/);
});

test('Conflicting restoration retains drafts and cleans the destination', async (context) => {
  const directory = await fixture(context);
  const page = path.join(directory, 'page.txt');
  await fs.writeFile(page, 'parked draft\n');
  await parkBranch(directory, 'feature');
  await fs.writeFile(page, 'new committed version\n');
  await git(directory, ['add', 'page.txt']);
  await git(directory, ['commit', '--message', 'external change']);
  const result = await unparkBranch(directory, 'feature');
  assert.equal(result.restored, false);
  assert.match(result.error, /still parked/);
  assert.equal(await fs.readFile(page, 'utf8'), 'new committed version\n');
  assert.equal(await output(directory, ['status', '--porcelain']), '');
  assert.match(await output(directory, ['stash', 'list']), /stacki:park:feature/);
  assert.equal(await output(directory, ['show', 'stash@{0}:page.txt']), 'parked draft');
});

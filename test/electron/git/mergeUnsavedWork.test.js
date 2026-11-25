// Goal: merging works with unsaved work, and never loses it. In a project that is
// a folder of a larger repository, setting the work aside always threw; and work
// restored before the conflict review opened, in files the merge also writes,
// made finishing the merge fail with raw git status text. Method: real
// repositories, the app's own park and unpark, and the merge the review finishes.
// The negative space: work that cannot go back on the merged files stays parked
// and is reported, a merge that fails for another reason gives the work straight
// back, and without unsaved work nothing is parked.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveMerge } = require('#dist/electron/git/gitBranches.js');
const { parkBranch, unparkBranch } = require('#dist/electron/git/gitParking.js');
const { git, setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

const LINES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
const page = (changes = {}) => LINES.map((line, index) => changes[index] ?? line).join('\n') + '\n';

// `main` and `feature` clash over clash.txt, and feature also edits page.txt's
// first line. `folder` is where the project sits: '' for the repository root.
async function repository(testContext, folder) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-merge-work-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, folder);
  const sh = async (...args) => (await git(root, args)).stdout;
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  const read = (file) => fs.readFileSync(path.join(project, file), 'utf8');
  const commit = async (message) => {
    await sh('add', '-A');
    await sh('commit', '-qm', message);
  };
  await sh('init', '-q', '-b', 'main');
  await sh('config', 'core.autocrlf', 'false');
  await sh('config', 'user.email', 'test@example.com');
  await sh('config', 'user.name', 'Test');
  write('.gitignore', 'node_modules/\n');
  write('clash.txt', 'base\n');
  write('page.txt', page());
  await commit('first');
  await sh('checkout', '-q', '-b', 'feature');
  write('clash.txt', 'theirs\n');
  write('page.txt', page({ 0: 'theirs' }));
  await commit('feature');
  await sh('checkout', '-q', 'main');
  write('clash.txt', 'ours\n');
  await commit('main');
  const parking = {
    park: (branch) => parkBranch(project, branch),
    unpark: (branch) => unparkBranch(project, branch),
  };
  const finish = () =>
    resolveMerge(git, { projectPath: project, branch: 'feature', choices: { [`${folder === '' ? '' : `${folder}/`}clash.txt`]: 'theirs' }, parking });
  return { root, project, sh, write, read, finish };
}

const clashPath = (folder) => (folder === '' ? 'clash.txt' : `${folder}/clash.txt`);

for (const folder of ['', 'sites/my [site]']) {
  const where = folder === '' ? 'at the repository root' : 'in a subfolder';

  test(`unsaved work is parked and brought back ${where}`, async (testContext) => {
    const repo = await repository(testContext, folder);
    repo.write('node_modules/kept.js', 'ignored\n');
    repo.write('.stacki/preview/state.json', '{}\n');
    repo.write('page.txt', page({ 6: 'unsaved' }));
    repo.write('new.txt', 'untracked\n');
    assert.equal(await parkBranch(repo.project, 'main'), true);
    assert.equal((await repo.sh('status', '--porcelain')).trim(), '', 'the tree is clean');
    assert.equal(repo.read('node_modules/kept.js'), 'ignored\n', 'ignored files stay');
    assert.equal(repo.read('.stacki/preview/state.json'), '{}\n', 'generated files are not parked');
    assert.deepEqual(await unparkBranch(repo.project, 'main'), { restored: true });
    assert.equal(repo.read('page.txt'), page({ 6: 'unsaved' }));
    assert.equal(repo.read('new.txt'), 'untracked\n');
  });

  test(`finishing a merge over unsaved work keeps both ${where}`, async (testContext) => {
    const repo = await repository(testContext, folder);
    repo.write('page.txt', page({ 6: 'unsaved' }));
    const outcome = await repo.finish();
    assert.deepEqual(outcome, { ok: true, into: 'main', changed: true, resolved: 1 }, clashPath(folder));
    assert.equal(repo.read('clash.txt'), 'theirs\n');
    assert.equal(repo.read('page.txt'), page({ 0: 'theirs', 6: 'unsaved' }));
    assert.equal((await repo.sh('stash', 'list')).trim(), '');
    assert.match(await repo.sh('log', '-1', '--format=%P'), /\s/, 'a merge commit');
  });
}

test('work that cannot go back on the merged files stays parked, and says so', async (testContext) => {
  const repo = await repository(testContext, 'site');
  repo.write('page.txt', page({ 0: 'unsaved' }));
  const outcome = await repo.finish();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.parkedErrorRef.key, 'git.error.unparkFailed');
  assert.notEqual(outcome.parkedError, '');
  assert.equal(repo.read('page.txt'), page({ 0: 'theirs' }), 'the merge stands, with no conflict markers');
  assert.match(await repo.sh('stash', 'list'), /stacki:park:main/);
  assert.match(await repo.sh('stash', 'show', '-p', 'stash@{0}'), /\+unsaved/);
});

test('a merge that fails for another reason gives the work straight back', async (testContext) => {
  const repo = await repository(testContext, '');
  const hook = path.join(repo.root, '.git', 'hooks', 'commit-msg');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
  repo.write('page.txt', page({ 6: 'unsaved' }));
  await assert.rejects(repo.finish(), /refused/);
  assert.equal(repo.read('page.txt'), page({ 6: 'unsaved' }));
  assert.equal(repo.read('clash.txt'), 'ours\n');
  assert.equal((await repo.sh('stash', 'list')).trim(), '');
});

test('work in files the merge leaves alone is never parked', async (testContext) => {
  const repo = await repository(testContext, '');
  repo.write('other.txt', 'untracked\n');
  const parked = [];
  const outcome = await resolveMerge(git, {
    projectPath: repo.project,
    branch: 'feature',
    choices: { 'clash.txt': 'theirs' },
    parking: { park: async () => parked.push('park') > 0, unpark: async () => ({ restored: true }) },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(parked, []);
  assert.equal(repo.read('other.txt'), 'untracked\n');
});

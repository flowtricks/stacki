// Goal: the Files panel's git answer is true to real repositories: every kind of change, a project in a subfolder of a
// repository, names with spaces and accents, whole untracked and ignored folders, a project that is itself new or
// ignored, no repository at all, and bounds that end in "too many" instead of a shorter list.
//
// Method: real git in temporary repositories, run through the same reader main uses (electron/git/gitFileStatus.ts),
// each answer passed through the wire parser (shared/ipc/fileExplorer.ts) as the renderer receives it. The bounds and
// the codes git rarely makes are checked on porcelain text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { waitForSteady } = require('../../helpers/waitFor.js');
const { describeFileGitStatus, readFileGitStatus } = require('#dist/electron/git/gitFileStatus.js');
const { fileGitStateOf } = require('#dist/electron/git/gitHistory.js');
const { parseFileGitStatus, FILE_GIT_LIMITS } = require('#dist/shared/ipc/fileExplorer.js');

const execFileAsync = promisify(execFile);
const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const git = (cwd, args) => execFileAsync('git', [...args], { cwd, env: environment });
const run = (cwd, ...args) => execFileSync('git', args, { cwd, env: environment, stdio: 'pipe' });

function temporary(context) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-files-git-'));
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function write(root, file, text = `${file}\n`) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function repository(context) {
  const root = temporary(context);
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 'files@example.test');
  run(root, 'config', 'user.name', 'Files');
  run(root, 'config', 'commit.gpgsign', 'false');
  return root;
}
const commitAll = (root, message) => {
  run(root, 'add', '-A');
  run(root, 'commit', '-qm', message);
};
async function answerFor(project) {
  const read = await readFileGitStatus(git, project);
  return parseFileGitStatus(structuredClone(read.status));
}
const byPath = (entries) => Object.fromEntries(entries.map((entry) => [entry.path, entry]));

test('a project below the repository root, with spaces and accents, reports every kind of change relative to itself', async (context) => {
  const root = repository(context);
  const project = path.join(root, 'sites', 'my site ü');
  write(root, '.gitignore', 'node_modules/\n*.log\n');
  write(root, 'outside.txt');
  for (const file of ['changed.txt', 'gone/only.txt', 'old name.txt', 'staged.txt']) {
    write(project, file);
  }
  commitAll(root, 'start');
  write(root, 'outside.txt', 'changed outside the project\n');
  write(project, 'changed.txt', 'edited\n');
  fs.rmSync(path.join(project, 'gone', 'only.txt'));
  run(project, 'mv', 'old name.txt', 'né w.txt');
  write(project, 'added.txt');
  run(project, 'add', 'added.txt');
  write(project, 'fresh/deep/one.txt');
  write(project, 'fresh/skipped.log');
  write(project, 'node_modules/package/index.js');
  write(project, 'trace.log');

  const status = await answerFor(project);
  assert.equal(status.kind, 'repository');
  assert.equal(status.whole, 'tracked');
  const changes = byPath(status.changes);
  assert.deepEqual(Object.keys(changes).sort(), ['added.txt', 'changed.txt', 'fresh', 'gone/only.txt', 'né w.txt'].sort());
  assert.equal(changes['changed.txt'].state, 'modified');
  assert.equal(changes['added.txt'].state, 'added');
  assert.equal(changes['gone/only.txt'].state, 'deleted');
  assert.equal(changes['né w.txt'].state, 'renamed');
  assert.equal(changes['né w.txt'].from, 'old name.txt');
  assert.deepEqual([changes.fresh.state, changes.fresh.folder], ['untracked', true]);
  const ignored = byPath(status.ignored);
  assert.equal(ignored.node_modules.folder, true);
  assert.equal(ignored['trace.log'].folder, false);
  assert.ok(ignored['fresh/skipped.log'], 'an ignored file inside an untracked folder is still told apart');
});

test('a merge clash is a conflict, and a commit made elsewhere clears the marks', async (context) => {
  const root = repository(context);
  write(root, 'page.txt', 'one\n');
  commitAll(root, 'start');
  run(root, 'switch', '-qc', 'other');
  write(root, 'page.txt', 'theirs\n');
  commitAll(root, 'theirs');
  run(root, 'switch', '-q', 'main');
  write(root, 'page.txt', 'mine\n');
  commitAll(root, 'mine');
  assert.throws(() => run(root, 'merge', 'other'));
  const clash = await answerFor(root);
  assert.deepEqual(
    clash.changes.map((entry) => [entry.path, entry.state]),
    [['page.txt', 'conflicted']],
  );
  write(root, 'page.txt', 'both\n');
  commitAll(root, 'merged');
  assert.deepEqual((await answerFor(root)).changes, []);
});

test('a project that is itself new or ignored is told as a whole, and reading never writes the index', async (context) => {
  const root = repository(context);
  write(root, '.gitignore', 'scratch/\n');
  commitAll(root, 'start');
  write(root, 'new/project/index.txt');
  write(root, 'scratch/project/index.txt');
  assert.equal((await answerFor(path.join(root, 'new', 'project'))).whole, 'untracked');
  assert.equal((await answerFor(path.join(root, 'scratch', 'project'))).whole, 'ignored');
  const index = path.join(root, '.git', 'index');
  const before = fs.statSync(index).mtimeMs;
  // A touched file makes a plain `git status` rewrite the index; this read must not.
  fs.utimesSync(path.join(root, '.gitignore'), new Date(), new Date(Date.now() + 5_000));
  const read = await readFileGitStatus(git, root);
  assert.equal(fs.statSync(index).mtimeMs, before);
  assert.equal(fs.realpathSync(read.gitDirectory), fs.realpathSync(path.join(root, '.git')));
});

test('outside a repository, and with no git at all, the answer is none; another failure is thrown', async (context) => {
  const folder = temporary(context);
  assert.deepEqual(await readFileGitStatus(git, folder), { status: { kind: 'none' }, gitDirectory: undefined });
  const missing = async () => {
    throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  };
  assert.equal((await readFileGitStatus(missing, folder)).status.kind, 'none');
  const refused = async () => {
    throw new Error('fatal: detected dubious ownership');
  };
  await assert.rejects(() => readFileGitStatus(refused, folder), /dubious ownership/);
});

test('past the bound the answer is "too many", never a shorter list; too many ignored entries dim nothing', () => {
  const records = (code, count) => Array.from({ length: count }, (_each, index) => `${code} f${index}`).join('\0') + '\0';
  const atBound = describeFileGitStatus(records(' M', FILE_GIT_LIMITS.changesMax), '');
  assert.equal(atBound.kind, 'repository');
  assert.equal(atBound.changes.length, FILE_GIT_LIMITS.changesMax);
  assert.deepEqual(describeFileGitStatus(records(' M', FILE_GIT_LIMITS.changesMax + 1), ''), { kind: 'too-many', limit: FILE_GIT_LIMITS.changesMax });
  const ignored = describeFileGitStatus(`${records('!!', FILE_GIT_LIMITS.ignoredMax + 1)} M kept\0`, '');
  assert.deepEqual(ignored.ignored, []);
  assert.deepEqual(
    ignored.changes.map((entry) => entry.path),
    ['kept'],
  );
});

test('every porcelain code reads as one state, the working tree winning, and an unknown one throws', () => {
  for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    assert.equal(fileGitStateOf(code), 'conflicted', code);
  }
  const expected = { '??': 'untracked', ' M': 'modified', 'M ': 'modified', ' T': 'modified', AM: 'modified', 'A ': 'added', ' A': 'added' };
  Object.assign(expected, { 'C ': 'added', 'R ': 'renamed', RM: 'modified', ' D': 'deleted', 'D ': 'deleted', AD: 'deleted' });
  for (const [code, state] of Object.entries(expected)) {
    assert.equal(fileGitStateOf(code), state, code);
  }
  assert.throws(() => fileGitStateOf('Z '), /unknown status/);
});

test('the wire parser refuses what is not a git answer', () => {
  const good = { kind: 'repository', whole: 'tracked', changes: [{ path: 'a', state: 'modified', folder: false }], ignored: [] };
  assert.equal(parseFileGitStatus(good).changes[0].from, undefined);
  for (const bad of [
    undefined,
    { kind: 'other' },
    { kind: 'too-many', limit: -1 },
    { ...good, whole: 'half' },
    { ...good, changes: [{ path: '../a', state: 'modified', folder: false }] },
    { ...good, changes: [{ path: '', state: 'modified', folder: false }] },
    { ...good, changes: [{ path: 'a', state: 'ignored', folder: false }] },
    { ...good, ignored: [{ path: 'a' }] },
    { ...good, ignored: Array.from({ length: FILE_GIT_LIMITS.ignoredMax + 1 }, () => ({ path: 'a', folder: false })) },
  ]) {
    assert.throws(() => parseFileGitStatus(bad), JSON.stringify(bad)?.slice(0, 80));
  }
});

test('the git directory watcher hears the index and HEAD, once per burst, and nothing else', async () => {
  const { createGitDirectoryWatch } = require('#dist/electron/project/explorerWatch.js');
  let listener;
  let closed = 0;
  let heard = 0;
  const watch = createGitDirectoryWatch(
    () => (heard += 1),
    (_directory, next) => {
      listener = next;
      return { on: () => undefined, close: () => (closed += 1) };
    },
  );
  watch.follow('/repository/.git');
  // Names that are not git's state are dropped as they are heard, so they arm nothing: the count after the burst below
  // would be two had either of them started a report of its own.
  listener('index.lock');
  listener('FETCH_HEAD');
  assert.equal(heard, 0);
  listener('index');
  listener('HEAD');
  assert.equal(heard, 0, 'a burst is reported once it settles, not as it is heard');
  await waitForSteady({ what: 'one report for the burst', read: () => heard, until: (count) => count > 0 });
  assert.equal(heard, 1);
  watch.follow(undefined);
  assert.equal(closed, 1);
});

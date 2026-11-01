// Goal: historical file inspection reflects the selected commit, including roots,
// renames, deletions, binary files and merges, without touching the checkout.
// Methodology: create a real temporary Git repository and inspect its patches;
// use a stub runner only to exercise output limits and command failure.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readCommitDiff } = require('#dist/electron/git/gitCommitDiff.js');
const { COMMIT_DIFF_LIMITS } = require('#dist/shared/ipc/gitCommitDiff.js');
const execute = promisify(execFile);
const git = (cwd, args) => execute('git', args, { cwd, maxBuffer: 2_000_000 });

test('read-only patches cover file lifecycle and first-parent merges', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-diff-'));
  const run = async (...args) => (await git(directory, args)).stdout.trim();
  const write = (name, body) => fs.writeFile(path.join(directory, name), body);
  const commit = async (message) => {
    await run('add', '--all');
    await run('commit', '-qm', message);
    return run('rev-parse', 'HEAD');
  };
  const diff = async (hash, file, from) => {
    const result = await readCommitDiff(git, {
      projectPath: directory,
      commit: hash,
      path: file,
      from,
    });
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  try {
    await run('init', '-q', '-b', 'main');
    await run('config', 'user.name', 'Diff Test');
    await run('config', 'user.email', 'diff@example.com');
    await run('config', 'diff.suppressBlankEmpty', 'true');
    await write('page.txt', 'before\nkeep\n\n');
    // Brackets exercise Git pathspec expansion and are valid Windows filenames.
    await write('literal[ab].txt', 'literal\n');
    await write('literala.txt', 'unrelated\n');
    await write('image.bin', Buffer.from([0, 1, 2, 3]));
    const root = await commit('Root');
    assert.match(await diff(root, 'page.txt'), /@@ -0,0 \+1,3 @@\n\+before\n\+keep/);
    assert.match(await diff(root, 'image.bin'), /Binary files/);
    assert.match(await diff(root, 'literal[ab].txt'), /\+literal/);
    assert.doesNotMatch(await diff(root, 'literal[ab].txt'), /unrelated/);
    await write('page.txt', 'after\nkeep\n\n');
    const update = await commit('Update');
    assert.match(await diff(update, 'page.txt'), /-before\n\+after\n keep\n /);
    await run('mv', 'page.txt', 'renamed.txt');
    const rename = await commit('Rename');
    assert.match(await diff(rename, 'renamed.txt', 'page.txt'), /rename from page.txt/);
    await run('switch', '-qc', 'feature');
    await write('renamed.txt', 'feature\nkeep\n');
    await commit('Feature');
    await run('switch', 'main');
    await write('main.txt', 'main\n');
    await commit('Main');
    await run('merge', '--no-ff', 'feature', '-m', 'Merge');
    assert.match(await diff(await run('rev-parse', 'HEAD'), 'renamed.txt'), /-after\n\+feature/);
    await fs.unlink(path.join(directory, 'renamed.txt'));
    const deletion = await commit('Delete');
    assert.match(await diff(deletion, 'renamed.txt'), /-feature\n-keep/);
    await write('unsaved.txt', 'untouched');
    const status = await run('status', '--porcelain');
    assert.match(await diff(root, 'page.txt'), /\+before/);
    assert.equal(await run('status', '--porcelain'), status);
    assert.equal(await fs.readFile(path.join(directory, 'unsaved.txt'), 'utf8'), 'untouched');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('oversized patches and missing commits return explicit errors', async () => {
  const request = {
    projectPath: '/project',
    commit: 'a'.repeat(40),
    path: 'file',
    from: undefined,
  };
  for (const stdout of ['x'.repeat(COMMIT_DIFF_LIMITS.charactersMax + 1), '\n'.repeat(COMMIT_DIFF_LIMITS.linesMax)]) {
    const result = await readCommitDiff(async () => ({ stdout }), request);
    assert.equal(result.ok, false);
    assert.match(result.error, /too (large|many)/);
  }
  const result = await readCommitDiff(async () => {
    throw new Error('missing commit');
  }, request);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing commit/);
});

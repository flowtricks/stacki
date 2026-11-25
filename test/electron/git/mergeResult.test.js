// Goal: commit exactly the reviewed merge result, including manual overrides,
// without overwriting a changed repository. Method: real disposable Git repos,
// trial conflicts, stale/clean reruns, and exact source/HEAD/worktree assertions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { mergeBranch, resolveMerge } = require('#dist/electron/git/gitBranches.js');
const { renderResolved } = require('#dist/electron/git/conflicts.js');
const { mergeConflictSnapshot } = require('#dist/shared/ipc/mergeResolution.js');
const { parseIpcPayload } = require('#dist/shared/ipc/ipcPayloads.js');
const git = (cwd, args) => execute('git', args, { cwd });
const command = async (cwd, ...args) => (await git(cwd, args)).stdout.trim();

async function fixture(autoCRLF = 'false') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-merge-result-'));
  await command(directory, 'init', '--initial-branch=main');
  await command(directory, 'config', 'user.name', 'Merge Test');
  await command(directory, 'config', 'user.email', 'merge@example.com');
  await command(directory, 'config', 'core.autocrlf', autoCRLF);
  const base = '<Heading id="hero" class="old">Welcome</Heading>\n';
  const save = async (text) => {
    await fs.writeFile(path.join(directory, 'index.astro'), text);
    await command(directory, 'add', 'index.astro');
    await command(directory, 'commit', '--message=Change heading');
  };
  await save(base);
  await command(directory, 'checkout', '-b', 'topic');
  await save(base.replace('old', 'new'));
  await command(directory, 'checkout', 'main');
  await save(base.replace('Welcome', 'Hello world'));
  const conflict = await mergeBranch(git, { projectPath: directory, branch: 'topic' });
  assert.equal(conflict.conflicted, true);
  const file = conflict.files[0];
  const result = renderResolved(file.parts, ['merged']).replace('id="hero"', 'id="custom"');
  const choices = {
    'index.astro': {
      kind: 'text',
      text: result,
      expected: mergeConflictSnapshot(file.parts),
      expectedBranch: 'main',
    },
  };
  return { directory, save, result, choices };
}

for (const autoCRLF of ['false', 'true']) {
  test(`edited result keeps independent edits with core.autocrlf=${autoCRLF}`, async () => {
    const value = await fixture(autoCRLF);
    try {
      const payload = parseIpcPayload('git:resolveMerge', {
        projectPath: value.directory,
        branch: 'topic',
        choices: value.choices,
      });
      const result = await resolveMerge(git, payload);
      assert.equal(result.ok, true);
      assert.equal(await fs.readFile(path.join(value.directory, 'index.astro'), 'utf8'), value.result);
      assert.match(value.result, /id="custom" class="new">Hello world/);
      assert.equal((await command(value.directory, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3);
      assert.equal(await command(value.directory, 'status', '--porcelain'), '');
    } finally {
      await fs.rm(value.directory, { recursive: true, force: true });
    }
  });
}

test('stale source, target branch, and clean reruns never commit an outdated result', async () => {
  const value = await fixture();
  try {
    const before = await command(value.directory, 'rev-parse', 'HEAD');
    await assert.rejects(
      resolveMerge(git, {
        projectPath: value.directory,
        branch: 'topic',
        choices: { 'index.astro': { ...value.choices['index.astro'], expectedBranch: 'other' } },
      }),
      /branch changed/,
    );
    assert.equal(await command(value.directory, 'rev-parse', 'HEAD'), before);
    await value.save('<Heading id="hero" class="old">Newer work</Heading>\n');
    const newer = await command(value.directory, 'rev-parse', 'HEAD');
    await assert.rejects(resolveMerge(git, { projectPath: value.directory, branch: 'topic', choices: value.choices }), /changed since review/);
    assert.equal(await command(value.directory, 'rev-parse', 'HEAD'), newer);
    assert.equal(await command(value.directory, 'status', '--porcelain'), '');
    await command(value.directory, 'checkout', 'topic');
    await command(value.directory, 'merge', 'main', '--strategy=ours', '--no-edit');
    await command(value.directory, 'checkout', 'main');
    await assert.rejects(resolveMerge(git, { projectPath: value.directory, branch: 'topic', choices: value.choices }), /changed since review/);
    assert.equal(await command(value.directory, 'rev-parse', 'HEAD'), newer);
    assert.equal(await command(value.directory, 'status', '--porcelain'), '');
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

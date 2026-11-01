// Goal: connecting an existing repository preserves its history and local remotes.
// Method: push into isolated local bare Git repositories through the real workflow;
// rewrite only the test's GitHub remote URL, then verify fast-forward refusal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectRepository } = require('#dist/electron/git/githubRepository.js');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('existing repositories accept safe pushes and refuse unrelated history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-connect-'));
  try {
    const remote = path.join(directory, 'remote.git');
    git(directory, ['init', '--bare', remote]);
    const make = (name) => {
      const local = path.join(directory, name);
      fs.mkdirSync(local);
      git(local, ['init', '--initial-branch=main']);
      git(local, ['config', 'user.name', 'Test']);
      git(local, ['config', 'user.email', 'test@example.com']);
      fs.writeFileSync(path.join(local, 'file'), name);
      git(local, ['add', 'file']);
      git(local, ['commit', '--message', name]);
      return local;
    };
    const execute = async (cwd, args) => ({
      stdout: git(
        cwd,
        args.map((value) => (value === 'https://github.com/owner/site.git' ? remote : value)),
      ),
      stderr: '',
    });
    const first = make('first');
    const result = await connectRepository(execute, {
      projectPath: first,
      repository: 'owner/site',
    });
    assert.equal(result.ok, true);
    const published = git(remote, ['rev-parse', 'refs/heads/main']).trim();
    assert.equal(published, git(first, ['rev-parse', 'HEAD']).trim());
    const again = await connectRepository(execute, {
      projectPath: first,
      repository: 'owner/another',
    });
    assert.equal(again.ok, false);
    assert.match(again.error, /already has an origin/);
    assert.equal(git(first, ['remote', 'get-url', 'origin']).trim(), remote);
    const second = make('second');
    const refused = await connectRepository(execute, {
      projectPath: second,
      repository: 'owner/site',
    });
    assert.equal(refused.ok, false);
    assert.equal(git(remote, ['rev-parse', 'refs/heads/main']).trim(), published);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('clone handler creates a new Astro checkout and refuses an existing directory', async () => {
  const { registerGitRepositoryHandlers } = require('#dist/electron/handlers/gitRepositoryHandlers.js');
  const tools = require('#dist/electron/lib/nodeTools.js');
  const originalRun = tools.run;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-clone-'));
  try {
    const source = path.join(directory, 'source');
    const parent = path.join(directory, 'downloads');
    fs.mkdirSync(source);
    fs.mkdirSync(parent);
    git(source, ['init', '--initial-branch=main']);
    git(source, ['config', 'user.name', 'Test']);
    git(source, ['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ dependencies: { astro: '*' } }));
    git(source, ['add', 'package.json']);
    git(source, ['commit', '--message', 'Astro site']);
    // The CLI boundary clones a real local repository, without GitHub mutations.
    tools.run = async (command, args, cwd) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['repo', 'clone', 'https://github.com/owner/site', '.']);
      return { stdout: git(cwd, ['clone', source, '.']), stderr: '' };
    };
    const handlers = new Map();
    registerGitRepositoryHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      showOpenDialog: async () => ({ canceled: false, filePaths: [parent] }),
    });
    const clone = handlers.get('git:clone');
    const result = await clone({}, { repository: 'owner/site' });
    assert.deepEqual(result, { canceled: false, projectPath: path.join(parent, 'site') });
    assert.equal(git(result.projectPath, ['rev-parse', 'HEAD']), git(source, ['rev-parse', 'HEAD']));
    await assert.rejects(clone({}, { repository: 'owner/site' }), /EEXIST/);
    assert.equal(fs.existsSync(path.join(result.projectPath, 'package.json')), true);
  } finally {
    tools.run = originalRun;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

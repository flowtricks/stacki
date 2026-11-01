// Goal: repository setup preserves project files and pins authentication without publishing.
// Method: temporary real Git repositories plus recorded CLI replies; no remote writes occur.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import tools, { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { connectPublishingRepository, publishingRepositories, repositoryState } from '#dist/electron/project/publishRepositories.js';
import { discoverPublishing } from '#dist/electron/project/publishDiscovery.js';
import discovery from '#dist/electron/project/publishDiscoveryCommand.js';
setToolPathHome(homedir());
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-repository-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['remote', 'add', 'origin', 'git@github.com:work/existing.git']);
  await writeFile(path.join(root, 'page.astro'), '<h1>Unpublished</h1>');
  return root;
}
test('remote changes preserve project files', async (context) => {
  const root = await fixture(context);
  const initial = await repositoryState(root);
  assert.equal(initial.connected, 'work/existing');
  const connected = await connectPublishingRepository(root, {
    action: 'connect',
    account: 'work',
    repository: 'work/next',
    revision: initial.revision,
  });
  assert.equal(connected.ok, true);
  assert.equal((await repositoryState(root)).connected, 'work/next');
  assert.equal(await readFile(path.join(root, 'page.astro'), 'utf8'), '<h1>Unpublished</h1>');
  const stale = await connectPublishingRepository(root, {
    action: 'connect',
    account: 'work',
    repository: 'work/stale',
    revision: initial.revision,
  });
  assert.equal(stale.ok, false);
  assert.equal((await repositoryState(root)).connected, 'work/next');
});
test('creation pins the account without committing or reconnecting', async (context) => {
  const root = await fixture(context);
  const recorded: string[][] = [];
  context.mock.method(tools, 'run', async (executable: string, args: readonly string[], _root: string, options: { readonly env?: NodeJS.ProcessEnv }) => {
    assert.equal(executable, 'gh');
    recorded.push([...args]);
    if (args[0] === 'auth') {
      assert.equal(args.at(-1), 'work');
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    assert.equal(options.env?.['GH_TOKEN'], 'gho_private_test_token');
    assert.deepEqual(args, ['repo', 'create', 'work/new-site', '--private']);
    return { stdout: 'https://github.com/work/new-site', stderr: '' };
  });
  const created = await publishingRepositories(root, {
    action: 'create',
    account: 'work',
    name: 'new-site',
    private: true,
  });
  assert.equal(created.ok, true);
  assert.equal(recorded.length, 2);
  assert.equal((await repositoryState(root)).connected, 'work/existing');
  await assert.rejects(git(root, ['rev-parse', '--verify', 'HEAD']));
});
test('automatic account choice matches the remote owner instead of list order', async (context) => {
  const root = await fixture(context);
  context.mock.method(discovery, 'discoveryCommand', async () => ({
    hosts: {
      'github.com': [
        { login: 'personal', state: 'success' },
        { login: 'work', state: 'success' },
      ],
    },
  }));
  const result = await discoverPublishing(root, { provider: 'github', account: '' });
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(result.accounts[0]?.id, 'work');
  }
});

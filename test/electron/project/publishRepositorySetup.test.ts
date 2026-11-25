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
    owner: 'work',
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

test('creation under an organization creates org/name with the account credential', async (context) => {
  const root = await fixture(context);
  const recorded: string[][] = [];
  context.mock.method(tools, 'run', async (_executable: string, args: readonly string[], _root: string, options: { readonly env?: NodeJS.ProcessEnv }) => {
    recorded.push([...args]);
    if (args[0] === 'auth') {
      assert.equal(args.at(-1), 'work');
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    assert.equal(options.env?.['GH_TOKEN'], 'gho_private_test_token');
    return { stdout: 'https://github.com/acme-co/new-site', stderr: '' };
  });
  const created = await publishingRepositories(root, { action: 'create', account: 'work', owner: 'acme-co', name: 'new-site', private: false });
  assert.equal(created.ok, true);
  assert.deepEqual(recorded.at(-1), ['repo', 'create', 'acme-co/new-site', '--public']);
  if (created.ok) {
    assert.deepEqual(created.value.repositories, ['acme-co/new-site']);
  }
});
test('creation refusals say what to change', async (context) => {
  const root = await fixture(context);
  let stderr = '';
  context.mock.method(tools, 'run', async (_executable: string, args: readonly string[]) => {
    if (args[0] === 'auth') {
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    throw Object.assign(new Error('Command failed'), { stderr });
  });
  const cases = [
    ['GraphQL: Name already exists on this account (createRepository)', 'publish.repositories.error.exists'],
    ['Resource protected by organization SAML enforcement (HTTP 403)', 'publish.repositories.error.organizationApproval'],
    ['You do not have permission to create repositories (HTTP 403)', 'publish.repositories.error.organizationForbids'],
    ['socket hang up', 'publish.repositories.error.createFailed'],
  ] as const;
  for (const [text, key] of cases) {
    stderr = text;
    const result = await publishingRepositories(root, { action: 'create', account: 'work', owner: 'acme-co', name: 'new-site', private: true });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorRef?.key, key);
    }
  }
});
test('listing reads organizations from the active memberships endpoint, page by page', async (context) => {
  const root = await fixture(context);
  const queries: string[] = [];
  const page = (prefix: string, count: number) =>
    JSON.stringify(Array.from({ length: count }, (_, index) => ({ state: 'active', role: 'member', organization: { login: `${prefix}${index}` } })));
  context.mock.method(tools, 'run', async (_executable: string, args: readonly string[]) => {
    if (args[0] === 'auth') {
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    const query = String(args[1]);
    if (query.startsWith('user/memberships/orgs')) {
      queries.push(query);
      return { stdout: query.endsWith('page=1') ? page('a', 100) : page('b', 2), stderr: '' };
    }
    return { stdout: '[]', stderr: '' };
  });
  const listed = await publishingRepositories(root, { action: 'list', account: 'work' });
  assert.equal(listed.ok, true);
  assert.deepEqual(queries, ['user/memberships/orgs?state=active&per_page=100&page=1', 'user/memberships/orgs?state=active&per_page=100&page=2']);
  if (listed.ok) {
    assert.equal(listed.value.organizations.length, 102);
    assert.equal(listed.value.organizationAccess, 'available');
  }
});
test('a missing organization scope is reported, and repositories still list', async (context) => {
  const root = await fixture(context);
  context.mock.method(tools, 'run', async (_executable: string, args: readonly string[]) => {
    if (args[0] === 'auth') {
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    if (String(args[1]).startsWith('user/memberships/orgs')) {
      throw Object.assign(new Error('Command failed'), { stderr: 'This API operation needs the "read:org" scope. (HTTP 404)' });
    }
    return { stdout: JSON.stringify([{ full_name: 'work/site', permissions: { push: true } }]), stderr: '' };
  });
  const listed = await publishingRepositories(root, { action: 'list', account: 'work' });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.value.repositories, ['work/site']);
    assert.deepEqual(listed.value.organizations, []);
    assert.equal(listed.value.organizationAccess, 'needsScope');
  }
});
test('malformed organization replies are a failed read, never a trusted list', async (context) => {
  const root = await fixture(context);
  context.mock.method(tools, 'run', async (_executable: string, args: readonly string[]) => {
    if (args[0] === 'auth') {
      return { stdout: 'gho_private_test_token', stderr: '' };
    }
    return { stdout: String(args[1]).startsWith('user/memberships/orgs') ? '{"message":"nope"}' : '[]', stderr: '' };
  });
  const listed = await publishingRepositories(root, { action: 'list', account: 'work' });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.value.organizations, []);
    assert.equal(listed.value.organizationAccess, 'failed');
  }
});

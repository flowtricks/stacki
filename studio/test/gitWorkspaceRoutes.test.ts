// Goal: verify the shipped HTTP workflows, not just the underlying Git helpers.
// Method: use real local commits, durable drafts and rooms, and replay stale requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { startGitWorkspaceHTTP } from './gitWorkspaceHTTP';
import { record } from '../src/shared/validation';
import { gitWorkspaceRun } from '../src/features/history/gitWorkspaceObjects';
import { gitWorkspaceBranch } from '../src/features/history/gitWorkspaceContract';

async function command(origin: string, name: string, data: unknown, workspace = '') {
  return fetch(origin + '/studio/api/git/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-studio-workspace': workspace },
    body: JSON.stringify(data),
  });
}
test('shared branch changes retire old rooms and reject stale browser mutations', async () => {
  const setup = await createGitWorkspaceFixture();
  const server = await startGitWorkspaceHTTP(setup.root, setup.connection);
  try {
    const original = await server.rooms.get('src/pages/index.astro');
    const epoch = original.document.getMap('metadata').get('epoch');
    const created = await command(server.origin, 'checkout', { branch: 'feature', create: true });
    assert.equal(created.status, 200, await created.text());
    const identity = created.headers.get('x-studio-workspace') ?? '';
    assert.match(identity, /^git-/);
    const fresh = await server.rooms.get('src/pages/index.astro');
    assert.notEqual(fresh.document.getMap('metadata').get('epoch'), epoch);
    const stale = await command(server.origin, 'commit', { message: 'Stale browser' });
    assert.equal(stale.status, 409);
    const committed = await command(server.origin, 'commit', { message: 'Shared heading' }, identity);
    assert.equal(committed.status, 200, await committed.text());
    const main = await command(server.origin, 'checkout', { branch: 'main' }, identity);
    assert.equal(main.status, 200, await main.text());
    assert.equal(await readFile(path.join(setup.root, 'src/pages/index.astro'), 'utf8'), '<h1>Original</h1>');
  } finally {
    await server.stop();
    await rm(setup.parent, { recursive: true, force: true });
  }
});
test('a pull conflict resolves the witnessed remote commit rather than the local branch', async () => {
  const setup = await createGitWorkspaceFixture();
  const server = await startGitWorkspaceHTTP(setup.root, setup.connection);
  try {
    assert.equal((await command(server.origin, 'commit', { message: 'Local changes' })).status, 200);
    await writeFile(path.join(setup.remote, 'src/pages/index.astro'), '<h1>Remote</h1>');
    await setup.git('add', '.');
    await setup.git('commit', '--quiet', '-m', 'Remote');
    const pull = await command(server.origin, 'pull', { branch: 'main' });
    assert.equal(pull.status, 200);
    const conflict = record(await pull.json());
    assert.equal(conflict['conflicted'], true);
    assert.equal(conflict['branch'], 'refs/remotes/origin/main');
    const resolved = await command(server.origin, 'resolveMerge', {
      branch: conflict['branch'],
      choices: { 'src/pages/index.astro': 'theirs' },
    });
    assert.equal(resolved.status, 200, await resolved.text());
    assert.equal(await readFile(path.join(setup.root, 'src/pages/index.astro'), 'utf8'), '<h1>Remote</h1>');
    const state = await setup.workspace.load();
    const parents = await gitWorkspaceRun(state.git)(['show', '--no-patch', '--format=%P', gitWorkspaceBranch(state.manifest).head]);
    assert.equal(parents.split(' ').length, 2);
  } finally {
    await server.stop();
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('background Git reads queue with commit requests instead of rejecting them', async () => {
  const setup = await createGitWorkspaceFixture();
  const server = await startGitWorkspaceHTTP(setup.root, setup.connection);
  try {
    const responses = await Promise.all([
      command(server.origin, 'info', {}),
      command(server.origin, 'incoming', {}),
      command(server.origin, 'commit', { message: 'Concurrent commit' }),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal((await setup.workspace.info(await setup.workspace.load())).dirty, false);
  } finally {
    await server.stop();
    await rm(setup.parent, { recursive: true, force: true });
  }
});

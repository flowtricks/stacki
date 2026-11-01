/** Exercise real Git objects and durable checkpoints, including partial commits,
 * parked branch drafts, and recovery into a fresh object database after restart. */
import { gitWorkspaceNeedsRecovery, setGitWorkspaceBusy } from '../src/features/history/gitWorkspaceLease';
import { gitWorkspaceAvailability } from '../src/features/history/gitWorkspaceAvailability';
import { PublishStatusSource } from '../src/features/publishing/publishStatusSource';
import { publishGitWorkspace } from '../src/features/history/gitWorkspacePublish';
import { capturePublishSource } from '../src/features/publishing/publishSource';
import { published } from '../src/features/publishing/publishFailure';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { readGitWorkspace, writeLocalGitWorkspace } from '../src/features/history/gitWorkspaceStorage';
import { gitWorkspaceBranch } from '../src/features/history/gitWorkspaceContract';
import { gitWorkspaceRun, initializeGitWorkspace } from '../src/features/history/gitWorkspaceObjects';
import { checkpointGitWorkspace } from '../src/features/history/gitWorkspaceCheckpoint';
import { switchGitWorkspace } from '../src/features/history/gitWorkspaceSwitch';
import { prepareGitWorkspaceCheckout } from '../src/features/history/gitWorkspaceCheckout';
import { pullGitWorkspace } from '../src/features/history/gitWorkspaceActions';
import { mergeGitWorkspace } from '../src/features/history/gitWorkspaceMerge';
import { gitWorkspaceHistory } from '../src/features/history/gitWorkspaceHistory';

test('partial commits retain the draft and survive a fresh Git database', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const state = await setup.workspace.load();
    assert.equal((await setup.workspace.info(state)).dirty, true);
    const result = await setup.workspace.commit(state, 'Commit heading', ['src/pages/index.astro']);
    assert.equal(result.files, 1);
    const saved = await readGitWorkspace(setup.root);
    assert.ok(saved?.bundle);
    const run = gitWorkspaceRun(state.git);
    const head = gitWorkspaceBranch(saved).head;
    assert.equal(await run(['show', head + ':src/pages/index.astro']), '<h1>Changed</h1>');
    assert.equal(await run(['show', head + ':src/pages/about.astro']), '<h1>About</h1>');
    assert.equal(await run(['show', saved.draft + ':src/pages/about.astro']), '<h1>Draft</h1>');
    const view = await gitWorkspaceHistory(setup.root, '');
    assert.equal(view?.info.head, head);
    await rm(state.git.directory, { recursive: true, force: true });
    await initializeGitWorkspace(state.git, setup.connection, saved, { remote: setup.remote });
    assert.equal(await run(['show', head + ':src/pages/index.astro']), '<h1>Changed</h1>');
    assert.equal(await run(['show', saved.draft + ':src/pages/about.astro']), '<h1>Draft</h1>');
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('creating a branch carries drafts; switching parks and restores each branch', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const first = await setup.workspace.load();
    const created = await switchGitWorkspace(first, { branch: 'feature', create: true });
    await checkpointGitWorkspace(first.git, first.manifest, created.manifest);
    const next = await setup.workspace.load();
    const switched = await switchGitWorkspace(next, { branch: 'main' });
    assert.equal(switched.result.parked, true);
    assert.equal(switched.manifest.parked[0]?.name, 'feature');
    const checkout = await prepareGitWorkspaceCheckout(next.git, setup.head, switched.target);
    await checkpointGitWorkspace(next.git, next.manifest, switched.manifest);
    await checkout.apply();
    await checkout.dispose();
    assert.equal(await readFile(path.join(setup.root, 'src/pages/about.astro'), 'utf8'), '<h1>About</h1>');
    const restored = await switchGitWorkspace(await setup.workspace.load(), { branch: 'feature' });
    assert.equal(restored.result.restored, true);
    assert.equal(await gitWorkspaceRun(next.git)(['show', restored.target + ':src/pages/about.astro']), '<h1>Draft</h1>');
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('pull merges remote commits while retaining unrelated uncommitted changes', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await setup.workspace.commit(await setup.workspace.load(), 'Local heading', ['src/pages/index.astro']);
    await writeFile(path.join(setup.remote, 'src/pages/contact.astro'), '<h1>Contact</h1>');
    await setup.git('add', '.');
    await setup.git('commit', '--quiet', '-m', 'Remote contact');
    const state = await setup.workspace.load();
    const result = await pullGitWorkspace(state);
    assert.equal(result.result.ok, true);
    assert.ok(result.manifest);
    assert.ok(result.target);
    const run = gitWorkspaceRun(state.git);
    assert.equal(await run(['show', result.target + ':src/pages/about.astro']), '<h1>Draft</h1>');
    assert.equal(await run(['show', result.target + ':src/pages/contact.astro']), '<h1>Contact</h1>');
    assert.equal(await run(['show', gitWorkspaceBranch(result.manifest).head + ':src/pages/about.astro']), '<h1>About</h1>');
    assert.equal(await run(['rev-parse', 'HEAD']), gitWorkspaceBranch(state.manifest).head);
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('pull conflicts leave the preview and references unchanged until a reviewed resolution', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await setup.workspace.commit(await setup.workspace.load(), 'Local changes');
    await writeFile(path.join(setup.remote, 'src/pages/index.astro'), '<h1>Remote heading</h1>');
    await setup.git('add', '.');
    await setup.git('commit', '--quiet', '-m', 'Remote heading');
    const state = await setup.workspace.load();
    const pulled = await pullGitWorkspace(state);
    assert.equal(pulled.result.ok, false);
    assert.ok('conflicted' in pulled.result);
    assert.equal(await readFile(path.join(setup.root, 'src/pages/index.astro'), 'utf8'), '<h1>Changed</h1>');
    const resolved = await mergeGitWorkspace(state, 'main', await setup.git('rev-parse', 'HEAD'), {
      'src/pages/index.astro': 'theirs',
    });
    assert.equal(resolved.result.ok, true);
    assert.ok(resolved.target);
    assert.equal(await gitWorkspaceRun(state.git)(['show', resolved.target + ':src/pages/index.astro']), '<h1>Remote heading</h1>');
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('publishing retains explicit local commits in the pushed ancestry', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await setup.git('config', 'receive.denyCurrentBranch', 'ignore');
    await setup.workspace.commit(await setup.workspace.load(), 'Local heading', ['src/pages/index.astro']);
    const state = await setup.workspace.load();
    const local = gitWorkspaceBranch(state.manifest).head;
    const source = published(await capturePublishSource(setup.root, path.join(setup.parent, 'publish')));
    const receipt = await publishGitWorkspace(setup.root, source, setup.connection, state.manifest, { remote: setup.remote });
    assert.equal(await setup.git('rev-parse', 'main'), receipt.sha);
    assert.equal(await setup.git('rev-parse', 'main^'), local);
    assert.equal(await setup.git('show', 'main:src/pages/about.astro'), '<h1>Draft</h1>');
    assert.equal(gitWorkspaceBranch((await setup.workspace.load()).manifest).head, receipt.sha);
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});
test('publishing refuses to rewind newer remote commits even when its lease matches', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await setup.git('config', 'receive.denyCurrentBranch', 'ignore');
    await writeFile(path.join(setup.remote, 'src/pages/contact.astro'), '<h1>New remote page</h1>');
    await setup.git('add', '.');
    await setup.git('commit', '--quiet', '-m', 'Newer remote');
    const remoteHead = await setup.git('rev-parse', 'HEAD');
    const state = await setup.workspace.load();
    const manifest = { ...state.manifest, remote: [{ name: 'main', head: remoteHead }] };
    const source = published(await capturePublishSource(setup.root, path.join(setup.parent, 'publish')));
    await assert.rejects(publishGitWorkspace(setup.root, source, setup.connection, manifest, { remote: setup.remote }), /Pull from GitHub/);
    assert.equal(await setup.git('rev-parse', 'HEAD'), remoteHead);
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('failed durable acknowledgement preserves the last confirmed commit and blocks new edits', async (context) => {
  const setup = await createGitWorkspaceFixture();
  const backend = process.env['STUDIO_BACKEND_URL'];
  try {
    const state = await setup.workspace.load();
    context.mock.method(globalThis, 'fetch', async (input: unknown) =>
      String(input).includes('git-bundle') ? new Response(null, { status: 204 }) : new Response('Checkpoint changed', { status: 409 }),
    );
    process.env['STUDIO_BACKEND_URL'] = 'https://storage.test';
    await assert.rejects(setup.workspace.commit(state, 'Unacknowledged'), /storage rejected the action/);
    assert.deepEqual(await readGitWorkspace(setup.root), state.manifest);
    assert.equal(await gitWorkspaceRun(state.git)(['rev-parse', 'HEAD']), setup.head);
    assert.equal(gitWorkspaceNeedsRecovery(setup.root), true);
  } finally {
    if (backend === undefined) {
      delete process.env['STUDIO_BACKEND_URL'];
    } else {
      process.env['STUDIO_BACKEND_URL'] = backend;
    }
    setGitWorkspaceBusy(setup.root, 'idle');
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('committed changes are counted once in publishing availability', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await setup.workspace.commit(await setup.workspace.load(), 'Local changes');
    const state = await setup.workspace.load();
    const source = new PublishStatusSource(setup.root);
    assert.deepEqual(await gitWorkspaceAvailability(setup.root, source, setup.connection, state.manifest), { changed: true, commits: 1 });
    await writeFile(path.join(setup.root, 'src/pages/index.astro'), '<h1>Another edit</h1>');
    assert.deepEqual(await gitWorkspaceAvailability(setup.root, source, setup.connection, state.manifest), { changed: true, commits: 2 });
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('Git status reads partial-clone metadata without downloading missing blobs', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    await writeFile(path.join(setup.remote, 'README.md'), 'Unmanaged repository file');
    await setup.git('add', '.');
    await setup.git('commit', '--quiet', '-m', 'Add repository documentation');
    await setup.git('config', 'uploadpack.allowFilter', 'true');
    const head = await setup.git('rev-parse', 'HEAD');
    const blob = await setup.git('rev-parse', 'HEAD:README.md');
    const state = await setup.workspace.load();
    await rm(state.git.directory, { recursive: true, force: true });
    await setup.git('clone', '--quiet', '--bare', '--no-local', '--filter=blob:none', setup.remote, state.git.directory);
    await writeLocalGitWorkspace(setup.root, {
      ...state.manifest,
      branches: state.manifest.branches.map((branch) => ({ ...branch, head })),
      remote: [{ name: 'main', head }],
    });
    const run = gitWorkspaceRun(state.git);
    assert.ok((await run(['rev-list', '--objects', '--missing=print', head])).includes('?' + blob));
    await rename(setup.remote, setup.remote + '-offline');
    const info = await setup.workspace.info(await setup.workspace.load());
    assert.equal(info.dirty, true);
    assert.equal(info.ahead, 0);
    assert.ok((await run(['rev-list', '--objects', '--missing=print', head])).includes('?' + blob), 'Status did not hydrate repository content');
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

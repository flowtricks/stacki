// Goal: Git actions on the hosted workspace, a blobless partial clone, download missing file contents
// in batches and never one request per file (issue #104: a pull and a cold start took 10 to 20 minutes).
// Method: a real local origin that allows partial clones, and a real blobless workspace of it. The
// workspace's `uploadpack` is a wrapper that records each connection to the origin, including the
// ones Git makes by itself for a lazy fetch. Counts are asserted, never wall time. The same fixture
// checks what must not change: unchanged files are left alone, a failed download changes no file,
// and a submitted review never needs the workspace to download through its own, unauthorized, fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { startGitWorkspaceHTTP } from './gitWorkspaceHTTP';
import {
  gitWorkspaceRun,
  initializeGitWorkspace,
  snapshotGitWorkspace,
  gitWorkspaceCommit,
  hydrateGitTrees,
  HYDRATE_LIMITS,
} from '../src/features/history/gitWorkspaceObjects';
import { readGitWorkspace, writeLocalGitWorkspace } from '../src/features/history/gitWorkspaceStorage';
import { restoreGitWorkspaceCheckout } from '../src/features/history/gitWorkspaceRestore';
import { prepareGitWorkspaceCheckout } from '../src/features/history/gitWorkspaceCheckout';
import { pullGitWorkspace } from '../src/features/history/gitWorkspaceActions';
import { mergeGitWorkspace } from '../src/features/history/gitWorkspaceMerge';
import { importWorkspaceHead } from '../src/features/history/gitWorkspacePublish';
import { capturePublishSource } from '../src/features/publishing/publishSource';
import { published } from '../src/features/publishing/publishFailure';
import { RepositorySync } from '../src/features/github/sync';
import { createRooms } from '../src/features/collaboration/rooms';

const DOCUMENTS = 25;

/** An origin with files the editor never writes, and a workspace of it that holds no file contents. */
async function blobless(documents = DOCUMENTS) {
  const setup = await createGitWorkspaceFixture();
  await setup.git('config', 'uploadpack.allowFilter', 'true');
  await mkdir(path.join(setup.remote, 'docs'), { recursive: true });
  for (let index = 0; index < documents; index++) {
    await writeFile(path.join(setup.remote, `docs/${index}.md`), `document ${index}\n`);
  }
  await writeFile(path.join(setup.remote, 'package.json'), '{"type":"module"}\n');
  await setup.git('add', '.');
  await setup.git('commit', '--quiet', '-m', 'Add documents');
  const head = await setup.git('rev-parse', 'HEAD');
  const log = path.join(setup.parent, 'connections.log');
  const counter = path.join(setup.parent, 'upload-pack');
  await writeFile(counter, `#!/bin/sh\necho connection >> '${log.replaceAll('\\', '/')}'\nexec git-upload-pack "$@"\n`);
  await chmod(counter, 0o755);
  const initial = await setup.workspace.load();
  const manifest = {
    ...initial.manifest,
    branches: [{ name: 'main', head, workspace: 'legacy' }],
    remote: [{ name: 'main', head }],
  };
  const remote = pathToFileURL(setup.remote).href;
  await rm(initial.git.directory, { recursive: true, force: true });
  await initializeGitWorkspace(initial.git, setup.connection, manifest, { remote });
  const run = gitWorkspaceRun(initial.git);
  await run(['config', 'remote.origin.uploadpack', counter.replaceAll('\\', '/')]);
  await writeLocalGitWorkspace(setup.root, manifest);
  // What startup leaves: the baseline's files on disk.
  await writeFile(path.join(setup.root, 'src/pages/index.astro'), '<h1>Original</h1>');
  await writeFile(path.join(setup.root, 'src/pages/about.astro'), '<h1>About</h1>');
  await writeFile(path.join(setup.root, 'package.json'), '{"type":"module"}\n');
  const connections = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const reset = () => rm(log, { force: true });
  await reset();
  const missing = async (revision: string) =>
    (await run(['rev-list', '--objects', '--quiet', '--missing=print', revision + '^{tree}'])).split('\n').filter(Boolean).length;
  return { setup, git: initial.git, run, manifest, head, remote, connections, reset, missing };
}

/** A draft that differs from the baseline in one page, with the page then put back on disk. */
async function editedDraft(fixture: Awaited<ReturnType<typeof blobless>>) {
  const page = path.join(fixture.setup.root, 'src/pages/about.astro');
  await writeFile(page, '<h1>Edited</h1>');
  const tree = await snapshotGitWorkspace(fixture.git, fixture.head);
  const draft = await gitWorkspaceCommit(fixture.run, tree, [fixture.head], 'draft');
  await writeFile(page, '<h1>About</h1>');
  return { draft, page };
}

test('listing missing contents downloads nothing, and downloading them takes one request', async () => {
  const fixture = await blobless();
  try {
    assert.ok((await fixture.missing(fixture.head)) >= DOCUMENTS, 'The workspace starts without file contents');
    assert.equal(await fixture.connections(), 0, 'Listing what is missing must not fetch it');
    await hydrateGitTrees(fixture.git, [fixture.head]);
    assert.equal(await fixture.connections(), 1);
    assert.equal(await fixture.missing(fixture.head), 0);
    await hydrateGitTrees(fixture.git, [fixture.head]);
    assert.equal(await fixture.connections(), 1, 'Nothing missing, nothing requested');
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a large repository downloads in bounded batches', async () => {
  const fixture = await blobless(HYDRATE_LIMITS.batchObjects + 20);
  try {
    await hydrateGitTrees(fixture.git, [fixture.head]);
    assert.equal(await fixture.connections(), 2);
    assert.equal(await fixture.missing(fixture.head), 0);
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a cold start restores a draft with one request, not one per file', async () => {
  const fixture = await blobless();
  try {
    const { draft, page } = await editedDraft(fixture);
    await restoreGitWorkspaceCheckout(fixture.git, { ...fixture.manifest, draft }, fixture.head);
    assert.equal(await readFile(page, 'utf8'), '<h1>Edited</h1>');
    assert.equal(await readFile(path.join(fixture.setup.root, `docs/${DOCUMENTS - 1}.md`), 'utf8'), `document ${DOCUMENTS - 1}\n`);
    assert.equal(await fixture.connections(), 1);
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

async function pushRemoteChange(fixture: Awaited<ReturnType<typeof blobless>>, file: string, source: string) {
  await writeFile(path.join(fixture.setup.remote, file), source);
  await fixture.setup.git('add', '.');
  await fixture.setup.git('commit', '--quiet', '-m', 'Remote change');
  return fixture.setup.git('rev-parse', 'HEAD');
}

// Reading GitHub's branch list, fetching its commits, and one batch of file contents.
const PULL_CONNECTIONS_MAX = 3;

test('a pull and its checkout take a fixed number of requests', async () => {
  const fixture = await blobless();
  try {
    await pushRemoteChange(fixture, 'src/pages/contact.astro', '<h1>Contact</h1>');
    const pulled = await pullGitWorkspace(await fixture.setup.workspace.load());
    assert.ok(pulled.result.ok);
    assert.ok(pulled.target);
    const checkout = await prepareGitWorkspaceCheckout(fixture.git, fixture.head, pulled.target);
    await checkout.apply();
    await checkout.dispose();
    assert.equal(await readFile(path.join(fixture.setup.root, 'src/pages/contact.astro'), 'utf8'), '<h1>Contact</h1>');
    assert.ok((await fixture.connections()) <= PULL_CONNECTIONS_MAX, `${await fixture.connections()} requests`);
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a conflicted pull and its resolution stay batched and leave the draft alone', async () => {
  const fixture = await blobless();
  try {
    const page = path.join(fixture.setup.root, 'src/pages/index.astro');
    await writeFile(page, '<h1>Mine</h1>');
    await fixture.setup.workspace.commit(await fixture.setup.workspace.load(), 'Mine');
    const theirs = await pushRemoteChange(fixture, 'src/pages/index.astro', '<h1>Theirs</h1>');
    await fixture.reset();
    const pulled = await pullGitWorkspace(await fixture.setup.workspace.load());
    assert.equal(pulled.result.ok, false);
    assert.ok('conflicted' in pulled.result);
    assert.equal(await readFile(page, 'utf8'), '<h1>Mine</h1>');
    // The common ancestor's copy of the page was never on disk: it is part of the same batch.
    assert.ok((await fixture.connections()) <= PULL_CONNECTIONS_MAX, `${await fixture.connections()} requests`);
    await fixture.reset();
    const resolved = await mergeGitWorkspace(await fixture.setup.workspace.load(), 'main', theirs, { 'src/pages/index.astro': 'theirs' });
    assert.ok(resolved.result.ok);
    assert.equal(await fixture.connections(), 0);
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('startup restores unpublished commits from a checkpoint without per-file requests', async () => {
  const fixture = await blobless();
  try {
    await writeFile(path.join(fixture.setup.root, 'src/pages/index.astro'), '<h1>Committed</h1>');
    await writeFile(path.join(fixture.setup.root, 'src/pages/about.astro'), '<h1>Also committed</h1>');
    await fixture.setup.workspace.commit(await fixture.setup.workspace.load(), 'Unpublished');
    const manifest = await readGitWorkspace(fixture.setup.root);
    assert.ok(manifest?.bundle);
    await writeFile(path.join(fixture.setup.root, 'src/pages/index.astro'), '<h1>Original</h1>');
    await writeFile(path.join(fixture.setup.root, 'src/pages/about.astro'), '<h1>About</h1>');
    await rm(fixture.git.directory, { recursive: true, force: true });
    await initializeGitWorkspace(fixture.git, fixture.setup.connection, manifest, { remote: fixture.remote });
    // The commit fetch above used Git's own transport; count what comes after it.
    await fixture.run(['config', 'remote.origin.uploadpack', path.join(fixture.setup.parent, 'upload-pack').replaceAll('\\', '/')]);
    await fixture.reset();
    await restoreGitWorkspaceCheckout(fixture.git, manifest, fixture.head);
    assert.equal(await readFile(path.join(fixture.setup.root, 'src/pages/index.astro'), 'utf8'), '<h1>Committed</h1>');
    assert.equal(await fixture.connections(), 1);
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a failed download names the command, hides the token and changes no file', async () => {
  const fixture = await blobless();
  try {
    const { draft, page } = await editedDraft(fixture);
    await fixture.run(['config', 'remote.origin.url', pathToFileURL(path.join(fixture.setup.parent, 'gone.git')).href]);
    const token = 'secret-installation-token';
    await assert.rejects(prepareGitWorkspaceCheckout({ ...fixture.git, authorization: token }, fixture.head, draft), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fetch/);
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes(Buffer.from('x-access-token:' + token).toString('base64')));
      return true;
    });
    assert.equal(await readFile(page, 'utf8'), '<h1>About</h1>');
    await assert.rejects(readFile(path.join(fixture.setup.root, 'docs/0.md')));
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a checkout leaves identical files alone and still replaces every different one', async () => {
  const fixture = await blobless(1);
  try {
    const { draft, page } = await editedDraft(fixture);
    // An edit the target does not have, of the same size as the target's text: contents decide.
    await writeFile(page, '<h1>Editee</h1>');
    const unchanged = path.join(fixture.setup.root, 'package.json');
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(unchanged, past, past);
    await utimes(page, past, past);
    const before = await stat(unchanged);
    const checkout = await prepareGitWorkspaceCheckout(fixture.git, fixture.head, draft);
    await checkout.apply();
    await checkout.dispose();
    const after = await stat(unchanged);
    assert.equal(after.ino, before.ino, 'An identical file is not replaced');
    assert.equal(after.mtimeMs, before.mtimeMs, 'An identical file is not touched');
    assert.equal(await readFile(page, 'utf8'), '<h1>Edited</h1>');
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('submitting a review imports the workspace head without a download inside the workspace', async () => {
  const fixture = await blobless();
  try {
    await writeFile(path.join(fixture.setup.root, 'src/pages/index.astro'), '<h1>Local</h1>');
    await fixture.setup.workspace.commit(await fixture.setup.workspace.load(), 'Local');
    const manifest = await readGitWorkspace(fixture.setup.root);
    assert.ok(manifest);
    // Git's local transport gives the workspace's own fetch no credentials; an unreachable origin stands in.
    await fixture.run(['config', 'remote.origin.url', pathToFileURL(path.join(fixture.setup.parent, 'needs-credentials.git')).href]);
    const source = published(await capturePublishSource(fixture.setup.root, path.join(fixture.setup.parent, 'review')));
    const run = gitWorkspaceRun(source.git);
    await importWorkspaceHead(run, fixture.git, manifest, fixture.remote);
    assert.equal(await run(['cat-file', '-t', manifest.branches[0]?.head ?? '']), 'commit');
  } finally {
    await rm(fixture.setup.parent, { recursive: true, force: true });
  }
});

test('a lock left by a stopped Git command does not block every later action', async () => {
  const setup = await createGitWorkspaceFixture();
  const server = await startGitWorkspaceHTTP(setup.root, setup.connection);
  try {
    const state = await setup.workspace.load();
    await writeFile(path.join(state.git.directory, 'index.lock'), '');
    const response = await fetch(server.origin + '/studio/api/git/status', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200, await response.text());
  } finally {
    await server.stop();
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('a sync check that failed before Git took over does not keep publishing blocked', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const manifest = await readGitWorkspace(setup.root);
    assert.ok(manifest);
    await rm(path.join(setup.root, '.stacki/studio/state/git-workspace.json'));
    await writeFile(path.join(setup.root, '.stacki/studio/state/github-base.json'), JSON.stringify({ sha: setup.head }));
    const synchronization = new RepositorySync(
      setup.root,
      {
        incoming: () => Promise.reject(new Error('GitHub is unreachable')),
        acceptBase: () => Promise.resolve(),
      } as unknown as NonNullable<ConstructorParameters<typeof RepositorySync>[1]>,
      createRooms(setup.root),
    );
    await assert.rejects(synchronization.latest(), /unreachable/);
    await writeLocalGitWorkspace(setup.root, manifest);
    assert.deepEqual(await synchronization.latest(), { kind: 'idle' });
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

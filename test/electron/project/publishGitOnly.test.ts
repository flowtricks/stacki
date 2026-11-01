// Goal: Git-only publishing handles large projects without a checkout, build, or unsafe Git update.
// Method: publish to local bare repositories, inject changes at boundaries, and inspect refs/files.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, truncate, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { DesktopPublisher } from '#dist/electron/project/publisher.js';
import { createPublishSource, createPublishSnapshot } from '#dist/electron/project/publishSnapshot.js';
import { commitPublishSource } from '#dist/electron/project/publishCommit.js';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import commands from '#dist/electron/project/publishCommands.js';
import github from '#dist/electron/project/publishGitHub.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';
import { PUBLISH_GIT_LIMITS } from '#dist/electron/project/publishSize.js';

setToolPathHome(homedir());
const repositoryURL = 'https://github.com/example/fixture.git';

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-git-only-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'site');
  const remote = path.join(directory, 'remote.git');
  await mkdir(root);
  await mkdir(remote);
  await mkdir(path.join(root, '.stacki'));
  await writeFile(
    path.join(root, '.stacki/publish.json'),
    JSON.stringify({
      ...DEFAULT_PUBLISH_CONFIG,
      beforePublish: ['before'],
      afterPublish: ['after'],
    }),
  );
  await writeFile(path.join(root, 'page.txt'), 'Initial');
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Publishing Test']);
  await git(root, ['config', 'user.email', 'publishing@example.test']);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--quiet', '--message', 'Initial']);
  await git(remote, ['init', '--bare', '--initial-branch=main']);
  await git(root, ['remote', 'add', 'origin', repositoryURL]);
  await git(root, ['config', `url.${remote}.insteadOf`, repositoryURL]);
  return { root, remote };
}

async function waitForPublish(publisher: DesktopPublisher, root: string) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const state = publisher.state(root);
    if (state.kind !== 'running') {
      return state;
    }
    await delay(20);
  }
  assert.fail('Publishing did not finish in 60 seconds');
}

for (const target of ['github', 'all'] as const) {
  test(`${target} without hosting skips build, hooks and node_modules`, async (context) => {
    const { root, remote } = await fixture(context);
    const scripts = context.mock.method(commands, 'runPublishScripts', async () => {
      throw new Error('Scripts must not run');
    });
    await writeFile(path.join(root, 'page.txt'), 'Ready');
    const publisher = new DesktopPublisher();
    publisher.start(root, target, 'Update page');
    assert.deepEqual(await waitForPublish(publisher, root), {
      kind: 'done',
      github: true,
      hosting: false,
    });
    assert.equal(scripts.mock.callCount(), 0);
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, (await git(remote, ['rev-parse', 'refs/heads/main'])).stdout);
    assert.equal((await readPublishAvailability(root)).github, 'current');
  });
}

test('large listings and assets can push and report current', async (context) => {
  const { root, remote } = await fixture(context);
  await mkdir(path.join(root, 'public'));
  // Batches cap concurrent writes. These names alone exceed the old 1 MiB stdout buffer.
  for (let batch = 0; batch < 230; batch++) {
    await Promise.all(
      Array.from({ length: 64 }, (_, offset) => writeFile(path.join(root, 'public', `${batch * 64 + offset}-${'photo'.repeat(20)}.txt`), 'photo')),
    );
  }
  // Sparse assets cross 256 MiB without allocating a giant test buffer or a >100 MiB GitHub file.
  for (let index = 0; index < 6; index++) {
    const file = path.join(root, 'public', `asset-${index}.bin`);
    await writeFile(file, '');
    await truncate(file, 48 * 1024 * 1024);
  }
  const snapshot = await createPublishSnapshot(root);
  assert.equal(snapshot.ok, false);
  const publisher = new DesktopPublisher();
  publisher.start(root, 'all', 'Publish photo library');
  assert.deepEqual(await waitForPublish(publisher, root), {
    kind: 'done',
    github: true,
    hosting: false,
  });
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, (await git(remote, ['rev-parse', 'refs/heads/main'])).stdout);
  assert.equal((await readPublishAvailability(root)).github, 'current');
  await removeLargeFixtureFiles(root);
  const smaller = await createPublishSnapshot(root);
  assert.ok(smaller.ok, smaller.ok ? '' : smaller.error.message);
  context.after(() => rm(smaller.value.temporary, { recursive: true, force: true }));
});

async function removeLargeFixtureFiles(root: string): Promise<void> {
  // The old index still lists >10,000 files; only surviving files consume checkout capacity.
  const names = [
    ...Array.from({ length: 5000 }, (_, index) => `${index}-${'photo'.repeat(20)}.txt`),
    ...Array.from({ length: 6 }, (_, index) => `asset-${index}.bin`),
  ];
  for (let index = 0; index < names.length; index += 64) {
    await Promise.all(names.slice(index, index + 64).map((name) => rm(path.join(root, 'public', name))));
  }
  await mkdir(path.join(root, 'node_modules'));
}

test('inspection bounds files staged for removal before hashing', async (context) => {
  const { root } = await fixture(context);
  await git(root, ['rm', '--cached', 'page.txt']);
  await truncate(path.join(root, 'page.txt'), PUBLISH_GIT_LIMITS.bytesMax + 1);
  const source = await createPublishSource(root, 'github');
  assert.equal(source.ok, false);
  if (!source.ok) {
    assert.match(source.error.message, /8 GiB/);
  }
});

test('capture contains only an index and preserves real staging', async (context) => {
  const { root } = await fixture(context);
  await writeFile(path.join(root, 'page.txt'), 'Staged');
  await git(root, ['add', 'page.txt']);
  await writeFile(path.join(root, 'page.txt'), 'Working');
  const staged = (await git(root, ['write-tree'])).stdout;
  const source = await createPublishSource(root, 'github');
  assert.ok(source.ok);
  context.after(() => rm(source.value.temporary, { recursive: true, force: true }));
  assert.deepEqual(await readdir(source.value.temporary), ['index']);
  assert.equal((await git(root, ['write-tree'])).stdout, staged);
  assert.notEqual(`${source.value.tree}\n`, staged);
});

for (const change of ['file', 'branch', 'head'] as const) {
  test(`a changed ${change} prevents committing the captured source`, async (context) => {
    const { root } = await fixture(context);
    const source = await createPublishSource(root, 'github');
    assert.ok(source.ok);
    context.after(() => rm(source.value.temporary, { recursive: true, force: true }));
    if (change === 'file') {
      await writeFile(path.join(root, 'page.txt'), 'Changed after capture');
    } else if (change === 'branch') {
      await git(root, ['switch', '--create', 'other']);
    } else {
      await git(root, ['commit', '--allow-empty', '--quiet', '--message', 'Same tree, newer head']);
    }
    const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
    const result = await commitPublishSource(root, source.value, 'main', 'Publish');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'source-changed');
    }
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, head);
  });
}

test('incoming changes require Pull and preserve local work', async (context) => {
  const { root, remote } = await fixture(context);
  await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
  const other = path.join(root, '..', 'other');
  await git(root, ['clone', '--branch', 'main', remote, other]);
  await git(other, ['config', 'user.name', 'Another Editor']);
  await git(other, ['config', 'user.email', 'another@example.test']);
  await writeFile(path.join(other, 'incoming.txt'), 'Incoming');
  await git(other, ['add', '--all']);
  await git(other, ['commit', '--quiet', '--message', 'Incoming']);
  await git(other, ['push', 'origin', 'HEAD:refs/heads/main']);
  await writeFile(path.join(root, 'page.txt'), 'Local work');
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
  const index = (await git(root, ['write-tree'])).stdout;
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github', 'Local edit');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.match(state.message, /Pull from GitHub/);
    assert.equal(state.github, false);
  }
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal((await git(root, ['write-tree'])).stdout, index);
  assert.equal((await git(root, ['rev-parse', 'refs/remotes/origin/main'])).stdout, head);
});

test('bookkeeping failure preserves confirmation of the push', async (context) => {
  const { root, remote } = await fixture(context);
  context.mock.method(github, 'recordPublishedGitHub', async () => {
    throw new Error('Tracking reference is locked');
  });
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.equal(state.github, true);
    assert.match(state.message, /Saved to GitHub/);
  }
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, (await git(remote, ['rev-parse', 'refs/heads/main'])).stdout);
});

test('a rejected push retains the local commit and never confirms GitHub', async (context) => {
  const { root, remote } = await fixture(context);
  await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
  const previous = (await git(remote, ['rev-parse', 'refs/heads/main'])).stdout;
  await writeFile(path.join(remote, 'hooks/pre-receive'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
  await writeFile(path.join(root, 'page.txt'), 'Rejected by remote');
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github', 'Keep this local commit');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.equal(state.github, false);
    assert.match(state.message, /Git push failed/);
  }
  assert.notEqual((await git(root, ['rev-parse', 'HEAD'])).stdout, previous);
  assert.equal((await git(remote, ['rev-parse', 'refs/heads/main'])).stdout, previous);
  assert.equal((await git(root, ['rev-parse', 'refs/remotes/origin/main'])).stdout, previous);
});

test('a commit hook that changes the captured tree prevents pushing', async (context) => {
  const { root, remote } = await fixture(context);
  await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
  const previous = (await git(remote, ['rev-parse', 'refs/heads/main'])).stdout;
  await writeFile(
    path.join(root, '.git/hooks/pre-commit'),
    [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync('page.txt', 'Hook changed source');",
      "require('node:child_process').execFileSync('git', ['add', 'page.txt']);",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await writeFile(path.join(root, 'page.txt'), 'Intended source');
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github', 'Capture source');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.match(state.message, /Commit hooks changed/);
    assert.equal(state.github, false);
  }
  assert.equal((await git(remote, ['rev-parse', 'refs/heads/main'])).stdout, previous);
});

test('an unborn branch can publish its first commit without a build', async (context) => {
  const { root, remote } = await fixture(context);
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/first-publish']);
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github', 'First publish');
  assert.deepEqual(await waitForPublish(publisher, root), {
    kind: 'done',
    github: true,
    hosting: false,
  });
  assert.equal((await git(remote, ['rev-list', '--count', 'refs/heads/first-publish'])).stdout.trim(), '1');
});

test('capture invariant failures escape the operating error channel', async (context) => {
  const { root } = await fixture(context);
  await assert.rejects(
    commitPublishSource(
      root,
      {
        tree: 'invalid',
        head: undefined,
        index: '',
        temporary: '',
      },
      'main',
      'Message',
    ),
    /Assertion failed: Publish source carries a valid tree/,
  );
});

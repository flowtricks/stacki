// Goal: repository links cannot block startup, escape the draft, or disappear when publishing.
// Method: restore real Git trees through a local remote, including links and rejected tree entries.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { restorePublishRepository } from '../src/features/publishing/publishBootstrap';
import { publishGit, type PublishGit } from '../src/features/publishing/publishGit';
import { published } from '../src/features/publishing/publishFailure';
import { capturePublishSource, publishTreeFiles } from '../src/features/publishing/publishSource';
import { nativePublish } from '../src/features/github/nativePublish';

const connection = { repository: 'owner/site', branch: 'main', token: 'fixture-token' };
interface Entry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly content: string;
}

async function fixture(entries: readonly Entry[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-bootstrap-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const git = { root, directory: path.join(root, 'remote.git') };
  published(await publishGit(git, ['init', '--bare', git.directory]));
  assert(entries.length <= 10, 'Bootstrap fixture entry count is bounded');
  for (const entry of entries) {
    const blob = published(await publishGit(git, ['hash-object', '-w', '--stdin'], entry.content));
    published(
      await publishGit(git, ['update-index', '--add', '--cacheinfo', entry.mode, blob, entry.path]),
    );
  }
  const tree = published(await publishGit(git, ['write-tree']));
  const head = published(await publishGit(git, ['commit-tree', tree, '-m', 'Bootstrap fixture']));
  published(await publishGit(git, ['update-ref', 'refs/heads/main', head]));
  return { root, workspace, git, head };
}

async function redirectRemote(git: PublishGit, remote: string) {
  published(await publishGit(git, ['init', '--bare', git.directory]));
  published(
    await publishGit(git, [
      'config',
      'url.' + pathToFileURL(remote).href + '.insteadOf',
      'https://github.com/owner/site.git',
    ]),
  );
}

async function restore(state: Awaited<ReturnType<typeof fixture>>) {
  const git = {
    root: state.workspace,
    directory: path.join(state.workspace, '.stacki/studio/state/bootstrap.git'),
  };
  await mkdir(git.directory, { recursive: true });
  await redirectRemote(git, state.git.directory);
  return restorePublishRepository(state.workspace, { ...connection, sha: state.head });
}

test('startup omits links while publishing preserves them', async (context) => {
  const entries: readonly Entry[] = [
    { path: 'src/index.astro', mode: '100644', content: '<h1>Existing site</h1>' },
    { path: 'public/file name.txt', mode: '100644', content: 'asset bytes' },
    { path: 'script.sh', mode: '100755', content: 'echo existing' },
    { path: '.claude/skills/example', mode: '120000', content: '../../.agents/skills/example' },
    { path: 'outside-link', mode: '120000', content: '/etc/passwd' },
  ];
  const state = await fixture(entries);
  context.after(() => rm(state.root, { recursive: true, force: true }));
  assert.equal((await publishTreeFiles(state.git, state.head)).ok, false);
  assert.deepEqual(await restore(state), { ok: true, value: state.head });
  for (const entry of entries) {
    const file = path.join(state.workspace, entry.path);
    if (entry.mode === '120000') {
      await assert.rejects(lstat(file), { code: 'ENOENT' });
    } else {
      assert.equal(await readFile(file, 'utf8'), entry.content);
    }
  }
  await assert.rejects(lstat(path.join(state.workspace, '.stacki/studio/state/bootstrap.git')), {
    code: 'ENOENT',
  });
  await writeFile(path.join(state.workspace, 'src/index.astro'), '<h1>Published edit</h1>');
  const source = published(
    await capturePublishSource(state.workspace, path.join(state.root, 'capture')),
  );
  await redirectRemote(source.git, state.git.directory);
  const receipt = published(await nativePublish(source, state.head, connection));
  assert.notEqual(receipt.sha, state.head);
  for (const entry of entries.filter((entry) => entry.mode === '120000')) {
    assert.equal(
      published(await publishGit(state.git, ['show', receipt.sha + ':' + entry.path])),
      entry.content,
    );
    assert.match(
      published(await publishGit(state.git, ['ls-tree', receipt.sha, '--', entry.path])),
      /^120000 blob /,
    );
  }
});

test('link-only repositories never trigger a full index checkout', async (context) => {
  const state = await fixture([{ path: 'link', mode: '120000', content: '/etc/passwd' }]);
  context.after(() => rm(state.root, { recursive: true, force: true }));
  assert.deepEqual(await restore(state), { ok: true, value: state.head });
  await assert.rejects(lstat(path.join(state.workspace, 'link')), { code: 'ENOENT' });
});

test('startup rejects runtime state and submodules before writing', async (context) => {
  for (const invalid of ['.stacki/studio/state/secrets', 'submodule']) {
    const state = await fixture([
      { path: 'src/index.astro', mode: '100644', content: 'must not be written' },
      { path: invalid, mode: '100644', content: 'invalid' },
    ]);
    context.after(() => rm(state.root, { recursive: true, force: true }));
    if (invalid === 'submodule') {
      published(
        await publishGit(state.git, ['update-index', '--cacheinfo', '160000', state.head, invalid]),
      );
      const tree = published(await publishGit(state.git, ['write-tree']));
      state.head = published(await publishGit(state.git, ['commit-tree', tree, '-m', 'Submodule']));
    }
    assert.equal((await restore(state)).ok, false);
    await assert.rejects(lstat(path.join(state.workspace, 'src/index.astro')), { code: 'ENOENT' });
  }
});

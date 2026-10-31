// Goal: native publishing transfers large projects incrementally and never overwrites incoming work.
// Method: real Git object captures and a local bare remote redirected through repository config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, open, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePublishSource } from '../src/features/publishing/publishSource';
import { nativePublish } from '../src/features/github/nativePublish';
import { published } from '../src/features/publishing/publishFailure';
import { publishGit, publishGitEnvironment } from '../src/features/publishing/publishGit';
import { restorePublishRepository } from '../src/features/publishing/publishBootstrap';
import { publishDisk } from '../src/features/publishing/publishInventory';
import { createHostingSnapshot } from '../src/features/publishing/publishHostingSnapshot';

const connection = { repository: 'owner/site', branch: 'main', token: 'never-log-this-token' };
const run = (cwd: string, args: readonly string[]) =>
  execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // Git hooks export repository paths; fixtures must never inherit the caller's repository.
      PATH: process.env['PATH'],
      SystemRoot: process.env['SystemRoot'],
      HOME: cwd,
      TMPDIR: process.env['TMPDIR'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  }).trim();

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-native-'));
  const remote = path.join(root, 'remote.git');
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'src'), { recursive: true });
  await mkdir(path.join(site, 'public'));
  await writeFile(path.join(site, 'src/index.astro'), 'original');
  await writeFile(path.join(site, 'package.json'), '{}');
  run(site, ['init', '--initial-branch=main']);
  run(site, ['add', '.']);
  run(site, ['commit', '-m', 'Initial']);
  run(root, ['clone', '--bare', site, remote]);
  run(root, ['--git-dir=' + remote, 'config', 'uploadpack.allowFilter', 'true']);
  const head = run(site, ['rev-parse', 'HEAD']);
  return { root, site, remote, head };
}
async function capture(state: Awaited<ReturnType<typeof fixture>>, name: string) {
  const source = published(await capturePublishSource(state.site, path.join(state.root, name)));
  published(
    await publishGit(source.git, [
      'config',
      'url.' + pathToFileURL(state.remote).href + '.insteadOf',
      'https://github.com/owner/site.git',
    ]),
  );
  return source;
}

test('immutable source preserves binary data, unrelated configuration and newer drafts', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  await writeFile(path.join(state.site, 'src/index.astro'), 'captured');
  await writeFile(path.join(state.site, 'public/binary.png'), Buffer.from([0, 128, 255]));
  const source = await capture(state, 'capture');
  await writeFile(path.join(state.site, 'src/index.astro'), 'next draft');
  const result = published(await nativePublish(source, state.head, connection));
  assert.equal(run(state.remote, ['show', result.sha + ':src/index.astro']), 'captured');
  assert.equal(run(state.remote, ['show', result.sha + ':package.json']), '{}');
  assert.equal(run(state.remote, ['rev-parse', result.sha + '^']), state.head);
  assert.equal(await readFile(path.join(state.site, 'src/index.astro'), 'utf8'), 'next draft');
  const second = await capture(state, 'second');
  const stale = await nativePublish(second, state.head, connection);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, 'github_changed');
  }
  assert.equal(run(state.remote, ['rev-parse', 'main']), result.sha);
  assert.equal(
    (await readFile(path.join(source.git.directory, 'config'), 'utf8')).includes(connection.token),
    false,
  );
});

test('14,720 files and over 1.3 GB publish without buffered file contents or listings', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  for (let index = 0; index < 14720; index++) {
    await writeFile(
      path.join(state.site, 'public', 'photo-' + index + '-' + 'a'.repeat(70) + '.jpg'),
      'photo',
    );
  }
  for (let index = 0; index < 65; index++) {
    const file = await open(path.join(state.site, 'public', `large-${index}.bin`), 'w');
    await file.truncate(20 * 1024 ** 2);
    await file.close();
  }
  const source = await capture(state, 'large');
  assert.ok(source.files.length > 14720);
  assert.ok(source.files.reduce((bytes, file) => bytes + file.size, 0) > 1_300_000_000);
  await mkdir(path.join(state.site, 'node_modules'));
  published(await createHostingSnapshot(state.site, path.join(state.root, 'large-hosting')));
  const result = published(await nativePublish(source, state.head, connection));
  assert.equal(run(state.remote, ['rev-parse', 'main']), result.sha);
  assert.equal(
    run(state.remote, ['cat-file', '-s', result.sha + ':public/large-64.bin']),
    String(20 * 1024 ** 2),
  );
  const unchanged = await capture(state, 'unchanged');
  assert.equal(published(await nativePublish(unchanged, result.sha, connection)).sha, result.sha);
});

test('hosting copies isolate edits and resource failures happen before building', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  await mkdir(path.join(state.site, 'node_modules'));
  const snapshot = path.join(state.root, 'hosting');
  published(await createHostingSnapshot(state.site, snapshot));
  await writeFile(path.join(snapshot, 'src/index.astro'), 'build mutation');
  assert.equal(await readFile(path.join(state.site, 'src/index.astro'), 'utf8'), 'original');
  const file = await open(path.join(state.site, 'public/oversized.bin'), 'w');
  await file.truncate(101 * 1024 ** 2);
  await file.close();
  assert.equal(
    (await capturePublishSource(state.site, path.join(state.root, 'too-big'))).ok,
    false,
  );
  assert.equal(
    (await createHostingSnapshot(state.site, path.join(state.root, 'too-big-host'))).ok,
    false,
  );
});

test('Git child environment excludes inherited credentials, hooks, traces and helpers', () => {
  const environment = publishGitEnvironment({
    directory: '/tmp/git',
    root: '/tmp/site',
    authorization: 'token',
  });
  assert.equal(environment['GIT_TRACE'], undefined);
  assert.equal(environment['GITHUB_PRIVATE_KEY'], undefined);
  assert.equal(environment['GIT_CONFIG_NOSYSTEM'], '1');
  assert.equal(environment['GIT_TERMINAL_PROMPT'], '0');
});

test('startup restores Git bytes without an archive buffer and rejects invalid revisions', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  const root = path.join(state.root, 'restored');
  const directory = path.join(root, '.stacki/studio/state/bootstrap.git');
  await mkdir(directory, { recursive: true });
  run(root, ['init', '--bare', directory]);
  run(root, [
    '--git-dir=' + directory,
    'config',
    'url.' + pathToFileURL(state.remote).href + '.insteadOf',
    'https://github.com/owner/site.git',
  ]);
  const result = published(
    await restorePublishRepository(root, { ...connection, sha: state.head }),
  );
  assert.equal(result, state.head);
  assert.equal(await readFile(path.join(root, 'src/index.astro'), 'utf8'), 'original');
  await assert.rejects(readFile(path.join(directory, 'config')), { code: 'ENOENT' });
  assert.equal((await restorePublishRepository(root, { ...connection, sha: 'invalid' })).ok, false);
});

test('server rejection leaves the remote untouched and never exposes credentials', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  await writeFile(
    path.join(state.remote, 'hooks/pre-receive'),
    '#!' + process.execPath + '\nprocess.exit(1);\n',
    { mode: 0o700 },
  );
  await writeFile(path.join(state.site, 'src/index.astro'), 'changed');
  const source = await capture(state, 'rejected');
  const result = await nativePublish(source, state.head, connection);
  assert.equal(result.ok, false);
  assert.equal(run(state.remote, ['rev-parse', 'main']), state.head);
  assert.equal(JSON.stringify(result).includes(connection.token), false);
});

test('asset deletions share the same atomic commit as captured source', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  await writeFile(path.join(state.site, 'public/old.png'), 'old');
  run(state.site, ['add', '.']);
  run(state.site, ['commit', '-m', 'Asset']);
  run(state.site, ['push', state.remote, 'main']);
  const head = run(state.site, ['rev-parse', 'HEAD']);
  await rm(path.join(state.site, 'public/old.png'));
  await mkdir(path.join(state.site, '.stacki/studio/state'), { recursive: true });
  await writeFile(
    path.join(state.site, '.stacki/studio/state/asset-state.json'),
    JSON.stringify({
      deleted: ['public/old.png'],
      directories: [],
      removedDirectories: [],
    }),
  );
  const source = await capture(state, 'deleted');
  const result = published(await nativePublish(source, head, connection));
  assert.throws(() => run(state.remote, ['show', result.sha + ':public/old.png']));
  assert.equal(run(state.remote, ['show', result.sha + ':src/index.astro']), 'original');
});

test('aggregate budgets fail before Git hashing and hosting copies', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  for (let index = 0; index < 83; index++) {
    const file = await open(path.join(state.site, 'public', `limit-${index}.bin`), 'w');
    await file.truncate(100 * 1024 ** 2);
    await file.close();
  }
  assert.equal(
    (await capturePublishSource(state.site, path.join(state.root, 'over-budget'))).ok,
    false,
  );
  assert.equal(
    (await createHostingSnapshot(state.site, path.join(state.root, 'over-hosting'))).ok,
    false,
  );
});

test('disk and link checks reject unsafe captures before any build', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  assert.equal((await publishDisk(state.site, Number.MAX_SAFE_INTEGER)).ok, false);
  await symlink(path.join(state.site, 'src/index.astro'), path.join(state.site, 'public/link'));
  assert.equal((await capturePublishSource(state.site, path.join(state.root, 'linked'))).ok, false);
  assert.equal(
    (await createHostingSnapshot(state.site, path.join(state.root, 'linked-host'))).ok,
    false,
  );
});

test('Git timeouts terminate and reap the command instead of hanging a publish', async (context) => {
  const state = await fixture();
  context.after(() => rm(state.root, { recursive: true, force: true }));
  const source = await capture(state, 'timeout');
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const pending = publishGit(source.git, ['-c', 'alias.wait=!sleep 30', 'wait']);
  context.mock.timers.tick(600_001);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /ten-minute/);
  }
});

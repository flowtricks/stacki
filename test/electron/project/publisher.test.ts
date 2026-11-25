// Goal: failed builds cannot commit or push, and overlapping jobs cannot publish twice.
// Method: run the real publisher against a temporary Git project with a failing npm build.
// No GitHub request is made: failure must stop the workflow before its network boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { DesktopPublisher } from '#dist/electron/project/publisher.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';

setToolPathHome(homedir());

test('failed build leaves Git untouched and duplicate starts share the job', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publisher-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, '.stacki'));
  await writeFile(
    path.join(root, '.stacki/publish.json'),
    JSON.stringify({
      ...DEFAULT_PUBLISH_CONFIG,
      hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'site' },
    }),
  );
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { build: 'node fail.cjs' },
    }),
  );
  await writeFile(path.join(root, 'fail.cjs'), 'process.exit(7);');
  // A site ready for Workers, so the failure under test is the build's and not the readiness check before it.
  await writeFile(path.join(root, 'wrangler.json'), JSON.stringify({ name: 'site', assets: { directory: './dist' } }));
  await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/.bin/wrangler'), '');
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Publishing Test']);
  await git(root, ['config', 'user.email', 'publishing@example.test']);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--message', 'Initial fixture']);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
  await writeFile(path.join(root, 'page.txt'), 'Unpublished edit');
  const publisher = new DesktopPublisher();
  const started = publisher.start(root, 'all', 'Update the page');
  assert.equal(started.kind, 'running');
  assert.deepEqual(publisher.start(root, 'all'), started);
  assert.throws(() => publisher.start('/other-project', 'all'), /Another project/);
  let state = publisher.state(root);
  for (let attempt = 0; attempt < 500 && state.kind === 'running'; attempt++) {
    await delay(20);
    state = publisher.state(root);
  }
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.match(state.message, /npm failed/);
    assert.equal(state.github, false);
    assert.equal(state.hosting, false);
  }
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
  assert.deepEqual(publisher.state('/other-project'), { kind: 'idle' });
});

// Goal: shared settings select hosting without running scripts for GitHub-only actions.
// Method: real snapshot files and npm hooks, with an in-memory repository boundary; no live deploys.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Publisher } from '../src/features/publishing/publish';
import type { PublishedFile } from '../src/features/publishing/publishSource';
import { ok } from '../vendor/stacki/shared/core/result';
import { DEFAULT_PUBLISH_CONFIG } from '../vendor/stacki/shared/properties/publishConfig';
import { parsePublishState } from '../src/features/publishing/publishClient';

test('GitHub-only publishes shared settings while skipping hooks and hosting', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-settings-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'public', '.stacki/studio/state', '.stacki', 'node_modules']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  const config = {
    ...DEFAULT_PUBLISH_CONFIG,
    hosting: { provider: 'vercel', projectId: 'prj_1', organizationId: 'team_1' },
    beforePublish: ['before'],
    afterPublish: ['after'],
  };
  await writeFile(path.join(root, '.stacki/publish.json'), JSON.stringify(config));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { before: 'node hook.cjs', after: 'node hook.cjs' },
    }),
  );
  const output = path.join(root, 'hooks.txt');
  await writeFile(
    path.join(root, 'hook.cjs'),
    `require('node:fs').appendFileSync(${JSON.stringify(output)}, ` +
      "process.env.npm_lifecycle_event + ':' + process.env.STACKI_PUBLISH_TARGET + '\\n');",
  );
  let files: readonly PublishedFile[] = [];
  let deployments = 0;
  const publisher = new Publisher(
    root,
    {
      async commit(snapshot) {
        files = snapshot.files;
        return ok({ sha: 'b'.repeat(40), url: 'https://example.test/commit' });
      },
      async incoming() {
        throw new Error('Unexpected sync');
      },
      async acceptBase() {},
    },
    undefined,
    async () => {
      assert.fail('GitHub-only must not build');
    },
    undefined,
    async () => {
      deployments++;
      return 'live';
    },
  );
  const state = await publisher.publish('github');
  assert.equal(state.kind, 'committed', JSON.stringify(state));
  assert.equal(deployments, 0);
  assert.ok(files.some((file) => file.path === '.stacki/publish.json'));
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('hosting-only does not require GitHub and rejects missing hosting before building', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-hosting-'));
  try {
    let builds = 0;
    const publisher = new Publisher(root, undefined, undefined, async () => {
      builds++;
    });
    const state = await publisher.publish('hosting');
    assert.equal(state.kind, 'failed');
    if (state.kind === 'failed') {
      assert.match(state.message, /Choose a hosting provider/);
    }
    assert.equal(builds, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(
    parsePublishState({
      kind: 'committed',
      id: 'host-job',
      sha: '',
      url: '',
      github: 'skipped',
      deployment: 'live',
    }),
    {
      kind: 'committed',
      id: 'host-job',
      sha: '',
      url: '',
      github: 'skipped',
      deployment: 'live',
    },
  );
});

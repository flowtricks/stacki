// Goal: GitHub-connected hosting builds once remotely without a second local build or deploy.
// Method: real source captures and persisted settings, injected repository/confirmation boundaries,
// and negative cases proving other destinations and custom hooks are not silently redirected.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Publisher, type PublishState } from '../src/features/publishing/publish';
import {
  managedHostingFromEnvironment,
  managedPublishConfig,
} from '../src/features/publishing/managedHosting';
import { DEFAULT_PUBLISH_CONFIG } from '../vendor/stacki/shared/properties/publishConfig';
import { ok } from '../vendor/stacki/shared/core/result';
import { record } from '../src/shared/validation';
import { published } from '../src/features/publishing/publishFailure';
import { publishGit } from '../src/features/publishing/publishGit';

const hosting = { provider: 'cloudflare-workers', accountId: 'account', project: 'cms' } as const;
const config = { ...DEFAULT_PUBLISH_CONFIG, hosting };
const revision = 'b'.repeat(40);

for (const deployment of ['live', 'pending'] as const) {
  test(`managed publishing skips the duplicate build and reports ${deployment}`, async (context) => {
    const { root, source } = await managedFixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    let commits = 0;
    let confirmations = 0;
    const states: PublishState[] = [];
    const publisher = new Publisher(
      root,
      {
        async incoming() {
          throw new Error('Unexpected sync');
        },
        async acceptBase() {},
        async commit(captured) {
          commits++;
          assert.equal(
            published(
              await publishGit(captured.git, ['show', `${captured.tree}:src/pages/index.astro`]),
            ).trim(),
            '<h1>Latest draft</h1>',
          );
          return ok({ sha: revision, url: 'https://github.com/owner/site/commit/' + revision });
        },
      },
      undefined,
      async () => {
        assert.fail('Managed hosting must not build locally');
      },
      undefined,
      async (sha) => {
        assert.equal(sha, revision);
        confirmations++;
        return deployment;
      },
      undefined,
      undefined,
      hosting,
    );
    publisher.subscribe((state) => states.push(state));
    const result = await publisher.publish('all');
    assert.equal(result.kind, 'committed', JSON.stringify(result));
    if (result.kind !== 'committed') {
      throw new Error('Missing receipt');
    }
    assert.equal(result.deployment, deployment);
    assert.equal(commits, 1);
    assert.equal(confirmations, 1);
    const hostingOnly = await publisher.publish('hosting');
    assert.equal(hostingOnly.kind, 'failed');
    assert.equal(commits, 1, 'Hosting-only never silently pushes the draft');
    assert.equal(confirmations, 1);
    assert.equal(
      states.some((state) => state.kind === 'building' && state.stage === 'building'),
      false,
    );
    assert.equal(await readFile(path.join(root, '.stacki/publish.json'), 'utf8'), source);
    assert.equal(
      record(
        JSON.parse(
          await readFile(path.join(root, '.stacki/studio/state/github-base.json'), 'utf8'),
        ),
      )['sha'],
      revision,
    );
  });
}

test('managed routing only applies to the configured account and Worker', () => {
  assert.equal(managedPublishConfig(config, 'all', undefined), config);
  assert.equal(managedPublishConfig(config, 'github', hosting), config);
  assert.equal(managedPublishConfig(config, 'all', { ...hosting, project: 'another' }), config);
  assert.equal(managedPublishConfig(config, 'all', { ...hosting, accountId: 'another' }), config);
  assert.equal(managedPublishConfig(config, 'all', { provider: 'none' }), config);
  assert.throws(() => managedPublishConfig(config, 'hosting', hosting), /Use Publish/);
  for (const changed of [
    { ...config, beforePublish: ['before'] },
    { ...config, afterPublish: ['after'] },
    { ...config, buildScript: 'custom' },
  ]) {
    assert.throws(() => managedPublishConfig(changed, 'all', hosting), /custom publish scripts/);
  }
});

test('managed environment validates configuration before selecting a destination', (context) => {
  context.mock.property(process, 'env', {
    ...process.env,
    STUDIO_GITHUB_DEPLOY_WORKER: '',
    STUDIO_GITHUB_DEPLOY_ACCOUNT: '',
    STUDIO_DEPLOYMENT_URL: '',
  });
  assert.equal(managedHostingFromEnvironment(), undefined);
  process.env['STUDIO_GITHUB_DEPLOY_WORKER'] = 'cms';
  assert.throws(managedHostingFromEnvironment, /confirmation URL/);
  process.env['STUDIO_DEPLOYMENT_URL'] = 'https://site.test/__studio-deployment';
  assert.throws(managedHostingFromEnvironment);
  process.env['STUDIO_GITHUB_DEPLOY_ACCOUNT'] = 'account';
  assert.deepEqual(managedHostingFromEnvironment(), hosting);
});

async function managedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-managed-hosting-'));
  for (const directory of ['src/pages', '.stacki/studio/state', '.stacki']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Latest draft</h1>');
  const source = JSON.stringify(config);
  await writeFile(path.join(root, '.stacki/publish.json'), source);
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  return { root, source };
}

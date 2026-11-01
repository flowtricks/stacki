// Goal: only confirmed destinations become current, independently and across app restarts.
// Method: use real temporary Git repositories and stub deployment commands, never a live host.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, truncate } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import { readPublishTree, createPublishSnapshot } from '#dist/electron/project/publishSnapshot.js';
import { deploymentConfiguration, parseDeploymentReceipt, readDeploymentReceipt, recordDeployment } from '#dist/electron/project/publishReceipt.js';
import { DesktopPublisher } from '#dist/electron/project/publisher.js';
import commands from '#dist/electron/project/publishCommands.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';
import { parsePublishAvailability } from '#dist/shared/properties/publishState.js';

setToolPathHome(homedir());
const config = {
  ...DEFAULT_PUBLISH_CONFIG,
  hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' },
} as const;
const repositoryUrl = 'https://github.com/example/fixture';

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-availability-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, '.stacki'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  await writeFile(path.join(root, '.stacki/publish.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'page.txt'), 'Published content');
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Publishing Test']);
  await git(root, ['config', 'user.email', 'publishing@example.test']);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--message', 'Initial fixture']);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
  await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

async function waitForPublish(publisher: DesktopPublisher, root: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = publisher.state(root);
    if (state.kind !== 'running') {
      return state;
    }
    await delay(20);
  }
  assert.fail('Publish did not complete within ten seconds');
}

test('GitHub detects dirty and unpushed changes independently', async (context) => {
  const root = await fixture(context);
  assert.deepEqual(await readPublishAvailability(root), {
    github: 'current',
    hosting: 'pending',
    githubPush: { commits: 0, repositoryUrl },
  });
  await writeFile(path.join(root, 'page.txt'), 'Edited');
  assert.equal((await readPublishAvailability(root)).github, 'pending');
  assert.equal((await readPublishAvailability(root)).githubPush?.commits, 1);
  await git(root, ['add', '--all']);
  assert.equal((await readPublishAvailability(root)).github, 'pending');
  await git(root, ['commit', '--message', 'Edit']);
  assert.equal((await readPublishAvailability(root)).github, 'pending');
  assert.equal((await readPublishAvailability(root)).githubPush?.commits, 1);
  await writeFile(path.join(root, 'page.txt'), 'Another edit');
  assert.equal((await readPublishAvailability(root)).githubPush?.commits, 2);
  await writeFile(path.join(root, 'page.txt'), 'Edited');
  await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  assert.equal((await readPublishAvailability(root)).github, 'current');
  // Git's update-ref exposes deletion only as -d, without a long-form alias.
  await git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.equal((await readPublishAvailability(root)).github, 'pending');
  assert.equal((await readPublishAvailability(root)).githubPush?.commits, 2);
});

for (const branch of ['main', 'feature/new-page']) {
  test(`GitHub push clears the commit count on ${branch}`, async (context) => {
    const root = await fixture(context);
    const remote = await mkdtemp(path.join(tmpdir(), 'stacki-push-remote-'));
    context.after(() => rm(remote, { recursive: true, force: true }));
    await git(remote, ['init', '--bare']);
    // Both incoming checks and pushes use a local remote; origin retains its GitHub identity.
    await git(root, ['config', `url.${remote}.insteadOf`, `${repositoryUrl}.git`]);
    if (branch !== 'main') {
      await git(root, ['switch', '--create', branch]);
    }
    context.mock.method(commands, 'runPublishScripts', async () => undefined);
    await writeFile(path.join(root, 'page.txt'), 'Ready to publish');
    const publisher = new DesktopPublisher();
    publisher.start(root, 'github', 'Update the homepage');
    assert.deepEqual(await waitForPublish(publisher, root), {
      kind: 'done',
      github: true,
      hosting: false,
    });
    const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal((await git(root, ['log', '-1', '--format=%B'])).stdout.trim(), 'Update the homepage');
    assert.equal((await git(remote, ['rev-parse', `refs/heads/${branch}`])).stdout.trim(), head);
    assert.equal((await git(root, ['rev-parse', `refs/remotes/origin/${branch}`])).stdout.trim(), head);
    assert.deepEqual(await readPublishAvailability(root), {
      github: 'current',
      hosting: 'pending',
      githubPush: { commits: 0, repositoryUrl },
    });
    publisher.start(root, 'github');
    assert.equal((await waitForPublish(publisher, root)).kind, 'done');
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  });
}

test('Dirty publishing requires a message before building or staging', async (context) => {
  const root = await fixture(context);
  const scripts = context.mock.method(commands, 'runPublishScripts', async () => undefined);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
  await writeFile(path.join(root, 'page.txt'), 'Needs a message');
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.match(state.message, /Enter a commit message/);
    assert.equal(state.github, false);
  }
  assert.equal(scripts.mock.callCount(), 0);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
});

test('A failed push never marks its commit as published', async (context) => {
  const root = await fixture(context);
  const remote = await mkdtemp(path.join(tmpdir(), 'stacki-rejected-push-'));
  context.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, ['init', '--bare']);
  await git(root, ['config', `url.${remote}.insteadOf`, `${repositoryUrl}.git`]);
  await git(root, ['config', `url.${root}/missing.git.pushInsteadOf`, `${repositoryUrl}.git`]);
  const previous = (await git(root, ['rev-parse', 'refs/remotes/origin/main'])).stdout;
  context.mock.method(commands, 'runPublishScripts', async () => undefined);
  await writeFile(path.join(root, 'page.txt'), 'Push will fail');
  const publisher = new DesktopPublisher();
  publisher.start(root, 'github', 'Update the homepage');
  const state = await waitForPublish(publisher, root);
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') {
    assert.equal(state.github, false);
  }
  assert.equal((await git(root, ['rev-parse', 'refs/remotes/origin/main'])).stdout, previous);
  assert.equal((await readPublishAvailability(root)).githubPush?.commits, 1);
});

test('Hosting records the dirty snapshot and preserves staging', async (context) => {
  const root = await fixture(context);
  context.mock.method(commands, 'runPublishScripts', async () => undefined);
  context.mock.method(commands, 'deployHosting', async () => undefined);
  await writeFile(path.join(root, 'page.txt'), 'Staged');
  await git(root, ['add', 'page.txt']);
  await writeFile(path.join(root, 'page.txt'), 'Unstaged');
  await writeFile(path.join(root, 'extra.txt'), 'Untracked');
  const staged = (await git(root, ['diff', '--cached'])).stdout;
  const publisher = new DesktopPublisher();
  publisher.start(root, 'hosting');
  assert.deepEqual(await waitForPublish(publisher, root), {
    kind: 'done',
    github: false,
    hosting: true,
  });
  assert.deepEqual(await readPublishAvailability(root), {
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 1, repositoryUrl },
  });
  assert.equal((await git(root, ['diff', '--cached'])).stdout, staged);
  const source = await readPublishTree(root);
  assert.ok(source.ok);
  assert.equal((await readDeploymentReceipt(root))?.tree, source.value);
  assert.equal(new DesktopPublisher().state(root).kind, 'idle');
  assert.equal((await readPublishAvailability(root)).hosting, 'current');
  await rm(path.join(root, 'extra.txt'));
  assert.equal((await readPublishAvailability(root)).hosting, 'pending');
  await writeFile(path.join(root, 'extra.txt'), 'Untracked');
  assert.equal((await readPublishAvailability(root)).hosting, 'current');
});

test('New edits and failed deployments stay pending', async (context) => {
  const root = await fixture(context);
  context.mock.method(commands, 'runPublishScripts', async () => undefined);
  const deployment = context.mock.method(commands, 'deployHosting', async () => {
    await writeFile(path.join(root, 'page.txt'), 'Newer than deployment');
  });
  const publisher = new DesktopPublisher();
  publisher.start(root, 'hosting');
  assert.equal((await waitForPublish(publisher, root)).kind, 'done');
  const receipt = await readDeploymentReceipt(root);
  assert.equal((await readPublishAvailability(root)).hosting, 'pending');
  deployment.mock.mockImplementation(async () => {
    throw new Error('Deployment failed');
  });
  publisher.start(root, 'hosting');
  assert.equal((await waitForPublish(publisher, root)).kind, 'failed');
  assert.deepEqual(await readDeploymentReceipt(root), receipt);
  assert.equal((await readPublishAvailability(root)).hosting, 'pending');
});

test('Settings changes and malformed receipts keep deploy available', async (context) => {
  const root = await fixture(context);
  const source = await readPublishTree(root);
  assert.ok(source.ok);
  await recordDeployment(root, {
    version: 1,
    tree: source.value,
    configuration: deploymentConfiguration(config),
  });
  assert.equal((await readPublishAvailability(root)).hosting, 'current');
  await writeFile(
    path.join(root, '.stacki/publish.json'),
    JSON.stringify({
      ...config,
      hosting: { ...config.hosting, project: 'another-site' },
    }),
  );
  assert.equal((await readPublishAvailability(root)).hosting, 'pending');
  await writeFile(path.join(root, '.stacki/publish.json'), JSON.stringify(config));
  await writeFile(path.join(root, '.git/stacki-deployment.json'), '{"version":1}');
  assert.equal((await readPublishAvailability(root)).hosting, 'unknown');
  await writeFile(path.join(root, '.git/stacki-deployment.json'), ' '.repeat(1025));
  assert.equal((await readPublishAvailability(root)).hosting, 'unknown');
  await writeFile(path.join(root, '.stacki/publish.json'), JSON.stringify(DEFAULT_PUBLISH_CONFIG));
  assert.equal((await readPublishAvailability(root)).hosting, 'unconfigured');
});

test('availability and receipt parsers reject malformed boundary values', () => {
  assert.deepEqual(parsePublishAvailability({ github: 'current', hosting: 'pending' }), {
    github: 'current',
    hosting: 'pending',
  });
  for (const value of [
    undefined,
    {},
    { github: true, hosting: 'current' },
    { github: 'current', hosting: 'done' },
    { github: 'pending', hosting: 'pending', githubPush: { commits: -1, repositoryUrl } },
    { github: 'pending', hosting: 'pending', githubPush: { commits: 1.5, repositoryUrl } },
    { github: 'pending', hosting: 'pending', githubPush: { commits: 1_000_001, repositoryUrl } },
    { github: 'current', hosting: 'pending', githubPush: { commits: 1, repositoryUrl } },
    {
      github: 'pending',
      hosting: 'pending',
      githubPush: {
        commits: 1,
        repositoryUrl: 'https://github.com.evil.test/owner/repo',
      },
    },
  ]) {
    assert.throws(() => parsePublishAvailability(value));
  }
  const push = { github: 'pending', hosting: 'current', githubPush: { commits: 2, repositoryUrl } };
  assert.deepEqual(parsePublishAvailability(push), push);
  const receipt = { version: 1, tree: 'a'.repeat(40), configuration: 'b'.repeat(64) };
  assert.deepEqual(parseDeploymentReceipt(receipt), receipt);
  for (const value of [
    undefined,
    {},
    { ...receipt, version: 2 },
    { ...receipt, tree: 'x' },
    { ...receipt, tree: 'a'.repeat(41) },
    { ...receipt, configuration: 1 },
    { ...receipt, configuration: 'b'.repeat(65) },
  ]) {
    assert.throws(() => parseDeploymentReceipt(value));
  }
});

test('snapshot bounds include files staged for removal', async (context) => {
  const root = await fixture(context);
  const ignored = path.join(root, '.env');
  await writeFile(ignored, 'Fixture only');
  await git(root, ['add', '--force', '.env']);
  await git(root, ['commit', '--message', 'Track fixture']);
  await git(root, ['rm', '--cached', '.env']);
  // A sparse file tests the limit without allocating or hashing 256 MiB.
  await truncate(ignored, 268_435_457);
  const snapshot = await createPublishSnapshot(root);
  assert.equal(snapshot.ok, false);
  if (!snapshot.ok) {
    assert.match(snapshot.error.message, /256 MiB/);
  }
});

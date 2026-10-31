import { DEFAULT_PUBLISH_CONFIG } from '../vendor/stacki/shared/properties/publishConfig';
// Goal: publishing keeps captured edits immutable and reports partial success honestly.
// Method: real Git object captures with an injected repository and build boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Publisher } from '../src/features/publishing/publish';
import type { RepositoryAccess } from '../src/features/github/github';
import { publishGit } from '../src/features/publishing/publishGit';
import { published } from '../src/features/publishing/publishFailure';
import { ok, err } from '../vendor/stacki/shared/core/result';
import { createRooms } from '../src/features/collaboration/rooms';

async function fixture(hosting = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-'));
  for (const directory of [
    'src/pages',
    'public',
    '.stacki/studio/state',
    '.stacki',
    'node_modules',
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Captured</h1>');
  await writeFile(path.join(root, 'public/photo.png'), Buffer.from([0, 1, 128, 255]));
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  if (hosting) {
    await writeFile(
      path.join(root, '.stacki/publish.json'),
      JSON.stringify({
        ...DEFAULT_PUBLISH_CONFIG,
        hosting: { provider: 'vercel', projectId: 'prj_1', organizationId: 'team_1' },
      }),
    );
  }
  return root;
}
function repository(commit: RepositoryAccess['commit']): RepositoryAccess {
  return {
    commit,
    async incoming() {
      throw new Error('Unexpected sync');
    },
    async acceptBase() {},
  };
}
const receipt = { sha: 'b'.repeat(40), url: 'https://github.com/example/site/commit/b' };

test('publishing captures accepted edits before their scheduled disk projection', async () => {
  const root = await fixture();
  const rooms = createRooms(root);
  const room = await rooms.get('src/pages/index.astro');
  room.text.insert(0, '<!-- accepted -->');
  let commits = 0;
  const publisher = new Publisher(
    root,
    repository(async (source) => {
      const content = published(
        await publishGit(source.git, ['show', `${source.tree}:src/pages/index.astro`]),
      );
      assert.equal(content.trim(), '<!-- accepted --><h1>Captured</h1>');
      commits++;
      return ok(receipt);
    }),
    rooms.coordinator,
    undefined,
    undefined,
    undefined,
    undefined,
    rooms.persist,
  );
  try {
    assert.equal(
      await readFile(path.join(root, 'src/pages/index.astro'), 'utf8'),
      '<h1>Captured</h1>',
    );
    assert.equal((await publisher.publish('github')).kind, 'committed');
    assert.equal(commits, 1);
  } finally {
    await room.durable.flush();
    room.document.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub and None skip builds, dependencies and hooks', async (context) => {
  for (const target of ['github', 'all'] as const) {
    const root = await fixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    await rm(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(root, '.stacki/publish.json'),
      JSON.stringify({
        ...DEFAULT_PUBLISH_CONFIG,
        beforePublish: ['fail'],
        afterPublish: ['fail'],
      }),
    );
    let commits = 0;
    const publisher = new Publisher(
      root,
      repository(async (source) => {
        assert.equal(source.files.length, 3);
        assert.equal(
          published(
            await publishGit(source.git, [
              'cat-file',
              'blob',
              source.tree + ':src/pages/index.astro',
            ]),
          ),
          '<h1>Captured</h1>',
        );
        commits++;
        return ok(receipt);
      }),
      undefined,
      async () => {
        assert.fail('Git-only must not build');
      },
    );
    const state = await publisher.publish(target);
    assert.equal(state.kind, 'committed', JSON.stringify(state));
    assert.equal(commits, 1);
  }
});

test('failed hosting builds never commit and snapshots preserve captured bytes', async (context) => {
  const root = await fixture(true);
  context.after(() => rm(root, { recursive: true, force: true }));
  let snapshotPath = '';
  const publisher = new Publisher(
    root,
    repository(async () => {
      assert.fail('Failed builds must not commit');
    }),
    undefined,
    async (snapshot) => {
      snapshotPath = snapshot;
      await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Next draft</h1>');
      assert.equal(
        await readFile(path.join(snapshot, 'src/pages/index.astro'), 'utf8'),
        '<h1>Captured</h1>',
      );
      assert.deepEqual(
        await readFile(path.join(snapshot, 'public/photo.png')),
        Buffer.from([0, 1, 128, 255]),
      );
      throw new Error('Build failed');
    },
  );
  const result = await publisher.publish();
  assert.equal(result.kind, 'failed');
  assert.match(JSON.stringify(result), /Build failed/);
  assert.match(
    await readFile(path.join(root, '.stacki/studio/state/github-base.json'), 'utf8'),
    /aaaa/,
  );
  await assert.rejects(access(snapshotPath));
});

test('a definite pre-push race captures the refreshed draft, but ambiguous failures never retry', async (context) => {
  for (const race of [true, false]) {
    const root = await fixture();
    context.after(() => rm(root, { recursive: true, force: true }));
    let attempts = 0;
    let refreshes = 0;
    const publisher = new Publisher(
      root,
      repository(async (_source, parent) => {
        if (++attempts === 1) {
          return err({ code: race ? 'github_changed' : 'network', message: 'Push failed' });
        }
        assert.equal(parent, 'b'.repeat(40));
        return ok(receipt);
      }),
      undefined,
      async () => {
        assert.fail('No build');
      },
      undefined,
      undefined,
      async () => {
        if (++refreshes === 2) {
          await writeFile(
            path.join(root, '.stacki/studio/state/github-base.json'),
            JSON.stringify(receipt),
          );
        }
      },
    );
    assert.equal((await publisher.publish()).kind, race ? 'committed' : 'failed');
    assert.equal(attempts, race ? 2 : 1);
  }
});

test('cleanup runs only after confirmed success and its failure retains the receipt', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  let cleanups = 0;
  const cleanup = async () => {
    cleanups++;
    throw new Error('Storage unavailable');
  };
  const failed = new Publisher(
    root,
    repository(async () => err({ code: 'git', message: 'Failed' })),
    undefined,
    undefined,
    cleanup,
  );
  assert.equal((await failed.publish()).kind, 'failed');
  assert.equal(cleanups, 0);
  const succeeded = new Publisher(
    root,
    repository(async () => ok(receipt)),
    undefined,
    undefined,
    cleanup,
  );
  const result = await succeeded.publish();
  assert.equal(result.kind, 'committed');
  assert.match(JSON.stringify(result), /Published successfully/);
  assert.equal(cleanups, 1);
});

test('programmer assertions escape the publish error UI', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const publisher = new Publisher(
    root,
    repository(async () => {
      assert.fail('Invariant broke');
    }),
  );
  await assert.rejects(publisher.publish(), /Invariant broke/);
});

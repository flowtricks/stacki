import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositorySync } from '../src/features/github/sync';
import { createRooms } from '../src/features/collaboration/rooms';
import type { RepositoryAccess, IncomingChanges } from '../src/features/github/github';

const before = 'heading\nfirst\nsecond\nthird\nfooter\n';
async function fixture(changes: IncomingChanges, draft: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-sync-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, '.stacki/studio/state'), { recursive: true });
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  await writeFile(path.join(root, 'src/pages/index.astro'), draft);
  const repository: RepositoryAccess = {
    async incoming() {
      return changes;
    },
    async acceptBase() {},
    async commit() {
      throw new Error('Sync must never publish');
    },
  };
  const rooms = createRooms(root);
  const room = await rooms.get('src/pages/index.astro');
  return {
    root,
    room,
    service: new RepositorySync(root, repository, rooms),
    async dispose() {
      room.document.destroy();
      rooms.sockets.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('deployment-only sync advances the baseline without changing the saved draft', async () => {
  const draft = before.replace('heading', 'unpublished heading');
  const state = await fixture({ sha: 'b'.repeat(40), files: [] }, draft);
  try {
    assert.deepEqual(await state.service.sync(), { kind: 'synced', sha: 'b'.repeat(40) });
    assert.equal(state.room.text.toString(), draft);
    assert.equal(await readFile(path.join(state.root, 'src/pages/index.astro'), 'utf8'), draft);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(state.root, '.stacki/studio/state/github-base.json'), 'utf8'),
      ),
      { sha: 'b'.repeat(40) },
    );
    assert.equal((await state.service.sync()).kind, 'synced');
    assert.equal(state.room.text.toString(), draft);
  } finally {
    await state.dispose();
  }
});
test('GitHub sync merges disjoint edits into the live collaborative document', async () => {
  const state = await fixture(
    {
      sha: 'b'.repeat(40),
      files: [
        { file: 'src/pages/index.astro', before, after: before.replace('footer', 'remote footer') },
      ],
    },
    before.replace('heading', 'draft heading'),
  );
  try {
    assert.equal((await state.service.sync()).kind, 'synced');
    assert.equal(
      state.room.text.toString(),
      before.replace('heading', 'draft heading').replace('footer', 'remote footer'),
    );
    assert.equal(
      await readFile(path.join(state.root, 'src/pages/index.astro'), 'utf8'),
      state.room.text.toString(),
    );
  } finally {
    await state.dispose();
  }
});
test('conflicts preserve the draft and baseline until a revision-specific resolution', async () => {
  const local = before.replace('heading', 'draft heading');
  const remote = before.replace('heading', 'remote heading');
  const state = await fixture(
    { sha: 'b'.repeat(40), files: [{ file: 'src/pages/index.astro', before, after: remote }] },
    local,
  );
  try {
    assert.equal((await state.service.sync()).kind, 'conflict');
    assert.equal(state.room.text.toString(), local);
    assert.match(
      await readFile(path.join(state.root, '.stacki/studio/state/github-base.json'), 'utf8'),
      /aaaa/,
    );
    assert.equal(
      (await state.service.sync({ sha: 'c'.repeat(40), side: 'github' })).kind,
      'failed',
    );
    assert.equal(state.room.text.toString(), local);
    assert.equal(
      (await state.service.sync({ sha: 'b'.repeat(40), side: 'github' })).kind,
      'synced',
    );
    assert.equal(state.room.text.toString(), remote);
  } finally {
    await state.dispose();
  }
});

test('automatic sync gives conflicting draft lines priority and retains unrelated GitHub updates', async () => {
  const local = before.replace('heading', 'draft heading');
  const remote = before.replace('heading', 'remote heading').replace('footer', 'remote footer');
  const state = await fixture(
    { sha: 'b'.repeat(40), files: [{ file: 'src/pages/index.astro', before, after: remote }] },
    local,
  );
  try {
    assert.equal((await state.service.latest()).kind, 'synced');
    assert.equal(state.room.text.toString(), local.replace('footer', 'remote footer'));
    assert.match(
      await readFile(path.join(state.root, '.stacki/studio/state/github-base.json'), 'utf8'),
      /bbbb/,
    );
  } finally {
    await state.dispose();
  }
});

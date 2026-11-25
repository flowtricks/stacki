// Goal: builds use immutable project snapshots without consuming the developer's staged changes.
// Method: use real temporary Git repositories, edit files after capture, and compare trees/indexes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { createPublishSnapshot, publishTree } from '#dist/electron/project/publishSnapshot.js';

setToolPathHome(homedir());

test('snapshot excludes ignored files and detects concurrent edits', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publish-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await git(root, ['init', '--initial-branch=main']);
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  await writeFile(path.join(root, '.env'), 'SECRET=not-for-upload');
  await writeFile(path.join(root, 'page.txt'), 'staged');
  await git(root, ['add', 'page.txt']);
  await writeFile(path.join(root, 'page.txt'), 'built snapshot');
  const staged = (await git(root, ['show', ':page.txt'])).stdout;
  const captured = await createPublishSnapshot(root);
  assert.ok(captured.ok);
  const snapshot = captured.value;
  context.after(() => rm(snapshot.temporary, { recursive: true, force: true }));
  assert.equal(await readFile(path.join(snapshot.root, 'page.txt'), 'utf8'), 'built snapshot');
  assert.equal((await git(root, ['show', ':page.txt'])).stdout, staged);
  await assert.rejects(readFile(path.join(snapshot.root, '.env')), { code: 'ENOENT' });
  assert.deepEqual(await publishTree(root, snapshot.index), { ok: true, value: snapshot.tree });
  await writeFile(path.join(root, 'page.txt'), 'next edit');
  const changed = await publishTree(root, snapshot.index);
  assert.ok(changed.ok);
  assert.notEqual(changed.value, snapshot.tree);
  assert.equal(await readFile(path.join(snapshot.root, 'page.txt'), 'utf8'), 'built snapshot');
});

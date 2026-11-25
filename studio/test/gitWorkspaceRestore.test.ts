/** Exercise startup restoration with real Git objects. Identical baselines must not
 * access the object store, while divergent unpublished drafts must still restore. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { restoreGitWorkspaceCheckout } from '../src/features/history/gitWorkspaceRestore';
import { readGitWorkspace } from '../src/features/history/gitWorkspaceStorage';

test('startup preserves the restored baseline without another Git checkout', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const state = await setup.workspace.load();
    await rm(state.git.directory, { recursive: true, force: true });
    await restoreGitWorkspaceCheckout(state.git, state.manifest, setup.head);
    assert.equal(await readFile(path.join(setup.root, 'src/pages/index.astro'), 'utf8'), '<h1>Changed</h1>');
    assert.deepEqual(await readGitWorkspace(setup.root), state.manifest);
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('startup restores a divergent branch and its unpublished draft', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const state = await setup.workspace.load();
    await setup.workspace.commit(state, 'Partial commit', ['src/pages/index.astro']);
    const manifest = await readGitWorkspace(setup.root);
    assert.ok(manifest?.draft);
    const file = path.join(setup.root, 'src/pages/about.astro');
    await writeFile(file, '<h1>Baseline</h1>');
    await restoreGitWorkspaceCheckout(state.git, manifest, setup.head);
    assert.equal(await readFile(file, 'utf8'), '<h1>Draft</h1>');
    assert.deepEqual(await readGitWorkspace(setup.root), manifest);
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyProject } from '../scripts/copyProject';

test('an embedded studio copies the site without copying itself or its draft', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-embedded-'));
  const studio = path.join(root, 'studio');
  const workspace = path.join(studio, '.studio/workspace');
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await mkdir(studio);
    await writeFile(path.join(root, 'package.json'), '{"name":"site"}');
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Site</h1>');
    await writeFile(path.join(studio, 'package.json'), '{"name":"cms"}');
    await copyProject(root, workspace, studio);
    assert.deepEqual((await readdir(workspace)).sort(), ['package.json', 'src']);
    assert.equal(await readFile(path.join(workspace, 'src/pages/index.astro'), 'utf8'), '<h1>Site</h1>');
    assert.equal(await readFile(path.join(root, 'src/pages/index.astro'), 'utf8'), '<h1>Site</h1>');
    await assert.rejects(() => copyProject(root, root, studio), /must not contain/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('matching image dependencies are reused and changed lockfiles trigger an install', async () => {
  const { linkImageDependencies } = await import('../scripts/dependencies');
  const { realpath } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'studio-deps-'));
  const site = path.join(root, 'site');
  const cached = path.join(root, 'cached');
  try {
    await mkdir(site);
    await mkdir(path.join(cached, 'node_modules'), { recursive: true });
    await writeFile(path.join(cached, 'package-lock.json'), 'original');
    await writeFile(path.join(site, 'package-lock.json'), 'changed');
    assert.equal(await linkImageDependencies(site, cached), false);
    await writeFile(path.join(site, 'package-lock.json'), 'original');
    assert.equal(await linkImageDependencies(site, cached), true);
    assert.equal(await realpath(path.join(site, 'node_modules')), await realpath(path.join(cached, 'node_modules')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

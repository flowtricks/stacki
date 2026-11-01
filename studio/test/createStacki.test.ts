import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseOptions, requireSupportedNode } from '../scripts/createStacki/options';
import { installedVersion, projectDirectory } from '../scripts/createStacki/project';

test('create-stacki options require deliberate installation and reject unknown switches', () => {
  assert.deepEqual(parseOptions([]), { directory: '.', yes: false, mode: 'install' });
  assert.deepEqual(parseOptions(['./my site', '--yes']), {
    directory: './my site',
    yes: true,
    mode: 'install',
  });
  assert.equal(parseOptions(['--agent']).mode, 'agent');
  assert.equal(parseOptions(['--help']).mode, 'help');
  assert.equal(parseOptions(['--version']).mode, 'version');
  assert.throws(() => parseOptions(['--force']), /Unknown option/);
  assert.throws(() => parseOptions(['one', 'two']), /only one/);
  assert.throws(() => parseOptions(['a'.repeat(4097)]), /oversized/);
  assert.throws(() => requireSupportedNode('22.18.0'), /22.19/);
  assert.throws(() => requireSupportedNode('20.19.0'), /22.19/);
  assert.throws(() => requireSupportedNode('invalid'), /22.19/);
  requireSupportedNode('22.19.0');
  requireSupportedNode('24.0.0');
});

test('create-stacki detects Astro and existing Studio without modifying project files', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'create-stacki-detect-'));
  const manifest = path.join(project, 'package.json');
  try {
    await writeFile(manifest, '{"dependencies":{"astro":"^7.0.0"}}');
    await assert.rejects(projectDirectory(project), /needs an npm lockfile/);
    await writeFile(path.join(project, 'package-lock.json'), '{"lockfileVersion":3}');
    assert.equal(await projectDirectory(project), await import('node:fs/promises').then((fs) => fs.realpath(project)));
    assert.equal(await installedVersion(project), undefined);
    await mkdir(path.join(project, 'studio/src/shared'), { recursive: true });
    await writeFile(path.join(project, 'studio/package.json'), '{"name":"@stacki/studio"}');
    await writeFile(path.join(project, 'studio/src/shared/release.json'), '{"version":"1.4.0"}');
    assert.equal(await installedVersion(project), '1.4.0');
    assert.equal(await readFile(manifest, 'utf8'), '{"dependencies":{"astro":"^7.0.0"}}');
    await writeFile(manifest, '{}');
    await assert.rejects(projectDirectory(project), /existing Astro project/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('create-stacki refuses unrelated folders and linked installations', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'create-stacki-refuse-'));
  try {
    const studio = path.join(project, 'studio');
    await mkdir(studio);
    await writeFile(path.join(studio, 'custom.txt'), 'keep me');
    await assert.rejects(installedVersion(project), /will not overwrite/);
    assert.equal(await readFile(path.join(studio, 'custom.txt'), 'utf8'), 'keep me');
    await rm(studio, { recursive: true });
    await symlink(project, studio, 'junction');
    await assert.rejects(installedVersion(project), /cannot be replaced/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

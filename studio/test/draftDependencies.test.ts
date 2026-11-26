// Goal: hydrate islands that load client modules through a draft's dependency link.
// Resolve the generated configuration with Vite and check the same filesystem rules that guard module requests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { isFileLoadingAllowed, normalizePath, resolveConfig } from 'vite';
import { draftDependencyRoot, writeStudioConfig } from '../scripts/workspace';

test('linked dependencies extend the detected Vite workspace without admitting the source project', async (context) => {
  const { workspace, workspaceRoot, source, dependencies, packageRoot } = await fixture(context);
  const sourceAlias = path.join(workspaceRoot, 'source alias');
  await symlink(source, sourceAlias, 'junction');
  await symlink(dependencies, path.join(workspace, 'node_modules'), 'junction');

  const dependencyRoot = await draftDependencyRoot(workspace, sourceAlias);
  assert.equal(dependencyRoot, dependencies);
  const vite = await resolveStudioVite(workspace, packageRoot, dependencyRoot);
  assert.equal(vite.server.fs.strict, true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(workspaceRoot, 'shared.js'))), true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(dependencies, 'renderer', 'client.js'))), true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(dependencies, '.env'))), false);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(source, 'private.js'))), false);
});

test('linked dependencies extend only the custom allow list and retain its deny rules and plugins', async (context) => {
  const { workspace, workspaceRoot, source, dependencies, packageRoot } = await fixture(context);
  await symlink(dependencies, path.join(workspace, 'node_modules'), 'junction');
  await writeFile(
    path.join(workspace, 'astro.config.mjs'),
    `export default { vite: { plugins: [{ name: 'project-plugin' }], server: { fs: { strict: true, allow: ['../assets'], deny: ['**/*.private.js'] } } } };`,
  );

  const vite = await resolveStudioVite(workspace, packageRoot, await draftDependencyRoot(workspace, source));
  assert.ok(vite.plugins.some((plugin) => plugin.name === 'project-plugin'));
  assert.equal(vite.server.fs.strict, true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(workspaceRoot, 'assets', 'shared.js'))), true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(workspaceRoot, 'unlisted.js'))), false);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(dependencies, 'renderer', 'client.js'))), true);
  assert.equal(isFileLoadingAllowed(vite, normalizePath(path.join(dependencies, 'renderer', 'client.private.js'))), false);
});

test('an explicit empty allow list and disabled strict mode keep the project settings', async (context) => {
  const { workspace, source, dependencies, packageRoot } = await fixture(context);
  await symlink(dependencies, path.join(workspace, 'node_modules'), 'junction');
  await writeFile(path.join(workspace, 'astro.config.mjs'), `export default { vite: { server: { fs: { strict: false, allow: [] } } } };`);

  const vite = await resolveStudioVite(workspace, packageRoot, await draftDependencyRoot(workspace, source));
  assert.equal(vite.server.fs.strict, false);
  assert.ok(vite.server.fs.allow.includes(normalizePath(dependencies)));
  assert.ok(!vite.server.fs.allow.includes(normalizePath(workspace)));
});

test('local installs, missing directories and redirected dependency links grant no extra access', async (context) => {
  const { workspace, source, dependencies, packageRoot } = await fixture(context);
  const draftModules = path.join(workspace, 'node_modules');
  assert.equal(await draftDependencyRoot(workspace, source), undefined);
  await mkdir(draftModules);
  assert.equal(await draftDependencyRoot(workspace, source), undefined);
  await rm(draftModules, { recursive: true });

  await symlink(dependencies, draftModules, 'junction');
  await rm(dependencies, { recursive: true });
  assert.equal(await draftDependencyRoot(workspace, source), undefined);
  await rm(draftModules);
  await symlink(packageRoot, draftModules, 'junction');
  await mkdir(dependencies);
  assert.equal(await draftDependencyRoot(workspace, source), undefined);
  await rm(dependencies, { recursive: true });
  await symlink(packageRoot, dependencies, 'junction');
  assert.equal(await draftDependencyRoot(workspace, source), undefined);
});

async function fixture(context: TestContext) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio draft dependencies ')));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporary, 'editor group');
  const workspace = path.join(workspaceRoot, 'draft');
  const source = path.join(temporary, 'source project');
  const dependencies = path.join(source, 'node_modules');
  const packageRoot = path.join(temporary, 'studio');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(dependencies, { recursive: true }),
    mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, 'package.json'), '{"type":"module"}'),
    writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n'),
    writeFile(path.join(packageRoot, 'dist', 'integration.mjs'), 'export default () => ({});\n'),
  ]);
  return { workspace, workspaceRoot, source, dependencies, packageRoot };
}

async function resolveStudioVite(workspace: string, packageRoot: string, dependencyRoot: string | undefined) {
  await writeStudioConfig(workspace, packageRoot, 4350, dependencyRoot);
  const configFile = path.join(workspace, 'vite.config.mts');
  await writeFile(configFile, `import config from './astro.studio.config.ts';\nexport default config.vite ?? {};\n`);
  return resolveConfig({ root: workspace, configFile }, 'serve');
}

// Goal: a site in a folder of its own inside a repository keeps working with versions. An old version is previewed
// from the site's folder of the checkout, not the repository's top; and a version from before the folder existed
// is refused, where restoring it used to delete every file of the site.
// Method: throwaway repositories under the system's temporary folder: one commit before `apps/web` exists, one that
// adds it, one that changes it, with a sibling app beside it. The preview checkout and the restore are driven with
// real git. A repository whose root is the site is checked to answer as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { type TestContext } from 'node:test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProject, buildProjectAt, removeProject } from '../../helpers/projectFixtures.ts';
import { ensureWorktree, previewPath, removeWorktree } from '#dist/electron/preview/previewWorktree.js';
import { restoreProject } from '#dist/electron/git/gitSnapshot.js';

const run = (directory: string, args: readonly string[]): string => execFileSync('git', [...args], { cwd: directory, encoding: 'utf8' }).trim();
const git = async (directory: string, args: readonly string[]) => ({ stdout: run(directory, args), stderr: '' });

function commit(directory: string, message: string): string {
  run(directory, ['add', '-A']);
  run(directory, ['commit', '-qm', message]);
  return run(directory, ['rev-parse', 'HEAD']);
}

function monorepo(context: TestContext) {
  const { root } = buildProject({ 'README.md': 'one\n', 'apps/api/server.js': 'api\n' }, 'stacki-subfolder-');
  context.after(() => removeProject(root));
  run(root, ['init', '-q', '-b', 'main', '.']);
  run(root, ['config', 'core.autocrlf', 'false']);
  run(root, ['config', 'user.email', 'test@example.com']);
  run(root, ['config', 'user.name', 'Test']);
  const beforeSite = commit(root, 'before the site');
  buildProjectAt(root, { 'apps/web/src/pages/index.astro': 'version one\n' });
  const first = commit(root, 'add the site');
  buildProjectAt(root, { 'apps/web/src/pages/index.astro': 'version two\n' });
  const second = commit(root, 'change the site');
  return { root, site: path.join(root, 'apps', 'web'), beforeSite, first, second };
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

test('an old version is served from the site’s folder of the checkout, and moves with the next', async (context) => {
  const { site, first, second } = monorepo(context);
  const made = await ensureWorktree(git, { projectPath: site, ref: first });
  assert.equal(made, path.join(previewPath(site), 'apps', 'web'));
  assert.equal(read(path.join(made, 'src/pages/index.astro')), 'version one\n');
  const moved = await ensureWorktree(git, { projectPath: site, ref: second });
  assert.equal(moved, made);
  assert.equal(read(path.join(moved, 'src/pages/index.astro')), 'version two\n');
  await removeWorktree(git, { projectPath: site });
  assert.equal(fs.existsSync(previewPath(site)), false);
});

test('a version from before the folder existed has no preview, and says why', async (context) => {
  const { site, beforeSite } = monorepo(context);
  await assert.rejects(ensureWorktree(git, { projectPath: site, ref: beforeSite }), /didn’t exist in that version/);
  await removeWorktree(git, { projectPath: site });
});

test('restoring a version from before the folder existed is refused and nothing changes', async (context) => {
  const { root, site, beforeSite } = monorepo(context);
  fs.writeFileSync(path.join(site, 'draft.txt'), 'unsaved\n');
  let parked = 0;
  const park = async () => {
    parked += 1;
    return true;
  };
  await assert.rejects(restoreProject(git, { projectPath: site, ref: beforeSite, park }), /didn’t exist in that version/);
  assert.equal(parked, 0, 'refused before anything is set aside');
  assert.equal(read(path.join(site, 'src/pages/index.astro')), 'version two\n');
  assert.equal(read(path.join(site, 'draft.txt')), 'unsaved\n');
  assert.equal(run(root, ['status', '--porcelain']), '?? apps/web/draft.txt');
});

test('restoring an older version of the folder still works and leaves its neighbours alone', async (context) => {
  const { root, site, first } = monorepo(context);
  await restoreProject(git, { projectPath: site, ref: first });
  assert.equal(read(path.join(site, 'src/pages/index.astro')), 'version one\n');
  assert.equal(read(path.join(root, 'apps/api/server.js')), 'api\n');
  assert.equal(read(path.join(root, 'README.md')), 'one\n');
});

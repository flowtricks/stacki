// Goal: the questions Stacki asks of a folder before it shows a project (is this Astro, are its
// packages installed, which package manager, which route does a page serve, which files are
// pages) answer correctly for monorepos, missing manifests and unusual page names.
// Method: generated trees in a temporary folder, each question asked directly of the
// module the scan and the open dialog call. Nothing is installed or executed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { ASTRO_BIN_NAME, buildProject, removeProject, volumeIsCaseInsensitive } from '../../helpers/projectFixtures.ts';
import { hasDependencies, isAstroProject, listAstroFiles, localAstroBin, routeForPage } from '#dist/electron/project/projectFiles.js';
import { detectPackageManager } from '#dist/electron/project/packageManager.js';

const PAGE = '<h1>x</h1>';

test('a folder is an Astro project by dependency, by config file, or by a workspace root that lists astro', (context) => {
  const built = buildProject({
    'dep/package.json': '{"devDependencies":{"astro":"5"}}',
    'peer/package.json': '{"peerDependencies":{"astro":"5"}}',
    'cfg-cjs/astro.config.cjs': 'module.exports = {};',
    'cfg-mts/astro.config.mts': 'export default {};',
    'root/package.json': '{"dependencies":{"astro":"5"}}',
    'root/site/package.json': '{"name":"site"}',
    'root/site/src/pages/index.astro': PAGE,
    'plain/package.json': '{"dependencies":{"react":"18"}}',
    'broken/package.json': '{ nope',
    'array/package.json': '[1]',
    'empty/readme.txt': 'x',
  });
  context.after(() => removeProject(built.root));
  const is = (folder: string) => isAstroProject(path.join(built.root, folder));
  assert.equal(is('dep'), true);
  assert.equal(is('peer'), true);
  assert.equal(is('cfg-cjs'), true);
  assert.equal(is('cfg-mts'), true);
  assert.equal(is('root/site'), true, 'a package under a workspace root that lists astro');
  assert.equal(is('plain'), false);
  assert.equal(is('broken'), false);
  assert.equal(is('array'), false);
  assert.equal(is('empty'), false);
  assert.equal(is('does-not-exist'), false);
});

test('installed packages are found in the package or in any parent workspace root', (context) => {
  const built = buildProject({
    [`own/node_modules/.bin/${ASTRO_BIN_NAME}`]: '#!/bin/sh',
    'hoisted/node_modules/astro/package.json': '{}',
    'hoisted/apps/web/package.json': '{}',
    'pnp/.pnp.cjs': '',
    'pnp/site/package.json': '{}',
    'none/package.json': '{}',
  });
  context.after(() => removeProject(built.root));
  const has = (folder: string) => hasDependencies(path.join(built.root, folder));
  assert.equal(has('own'), true);
  assert.equal(has('hoisted/apps/web'), true);
  assert.equal(has('pnp/site'), true);
  assert.equal(has('none'), false);
});

// Goal: a Bun install on Windows is found. Method: lay out .bin the way each manager does and ask for the command
// as each platform would. Bun writes astro.exe and no astro.cmd; looking only for the .cmd reported astro missing.
test('the astro command is the .cmd npm leaves or the .exe Bun leaves on Windows', (context) => {
  const built = buildProject({
    'bun/node_modules/.bin/astro.exe': 'MZ',
    'npm/node_modules/.bin/astro.cmd': '@echo off',
    'both/node_modules/.bin/astro.cmd': '@echo off',
    'both/node_modules/.bin/astro.exe': 'MZ',
    'empty/package.json': '{}',
  });
  context.after(() => removeProject(built.root));
  const bin = (folder: string, platform: NodeJS.Platform) => path.basename(localAstroBin(path.join(built.root, folder), platform));
  assert.equal(bin('bun', 'win32'), 'astro.exe');
  assert.equal(bin('npm', 'win32'), 'astro.cmd');
  assert.equal(bin('both', 'win32'), 'astro.cmd');
  assert.equal(bin('empty', 'win32'), 'astro.cmd');
  assert.equal(bin('bun', 'darwin'), 'astro');
});

test('the package manager comes from the nearest field or lockfile, looking through parents', (context) => {
  const built = buildProject({
    'field/package.json': '{"packageManager":"yarn@4.1.0+sha512.abc"}',
    'field/pnpm-lock.yaml': '',
    'pnpm/pnpm-lock.yaml': '',
    'yarn/yarn.lock': '',
    'bunb/bun.lockb': new Uint8Array([1]),
    'bunt/bun.lock': '{}',
    'npm/package-lock.json': '{}',
    'ws/pnpm-workspace.yaml': 'packages: []',
    'ws/apps/web/package.json': '{}',
    'mono/package.json': '{"packageManager":"pnpm@9.1.0"}',
    'mono/packages/site/yarn.lock': '',
    'mono/packages/other/package.json': '{}',
    'broken/package.json': '{ nope',
    'broken/yarn.lock': '',
    'none/package.json': '{}',
    // Detection looks through every parent: this one keeps a stray lockfile above the temp folder out of the answers.
    'package-lock.json': '{}',
  });
  context.after(() => removeProject(built.root));
  const manager = (folder: string) => detectPackageManager(path.join(built.root, folder));
  assert.equal(manager('field'), 'yarn');
  assert.equal(manager('pnpm'), 'pnpm');
  assert.equal(manager('yarn'), 'yarn');
  assert.equal(manager('bunb'), 'bun');
  assert.equal(manager('bunt'), 'bun');
  assert.equal(manager('npm'), 'npm');
  assert.equal(manager('ws/apps/web'), 'pnpm', 'the workspace root names it');
  assert.equal(manager('mono/packages/site'), 'yarn', 'a nearer lockfile beats a farther field');
  assert.equal(manager('mono/packages/other'), 'pnpm', 'a farther field applies when nothing is nearer');
  assert.equal(manager('broken'), 'yarn', 'an unreadable package.json falls back to the lockfile');
  assert.equal(manager('none'), 'npm');
});

test('routes keep dynamic segments and fold index files into their folder', () => {
  const pages = path.join('/p', 'src', 'pages');
  const route = (file: string) => routeForPage(pages, path.join(pages, file));
  assert.equal(route('index.astro'), '/');
  assert.equal(route('blog/index.md'), '/blog');
  assert.equal(route('blog/[slug].astro'), '/blog/[slug]');
  assert.equal(route('docs/[...rest].mdx'), '/docs/[...rest]');
  assert.equal(route('shop/[[optional]].astro'), '/shop/[[optional]]');
  assert.equal(route('about us.astro'), '/about us');
  assert.equal(route('日本語/ページ.astro'), '/日本語/ページ');
  assert.equal(route('(group)/a.astro'), '/(group)/a');
  assert.equal(route('index.astro.astro'), '/index.astro');
});

test('Markdown is a page only inside the pages folder, whatever the project path is called', (context) => {
  const built = buildProject({
    'pages/site/src/pages/index.astro': PAGE,
    'pages/site/src/pages/about.md': '# a',
    'pages/site/src/components/README.md': '# readme',
    'pages/site/src/components/Card.astro': PAGE,
    'pages/site/src/pages/_hidden.astro': PAGE,
    'pages/site/src/pages/_dir/inner.md': '# i',
    'pages/site/src/node_modules/pkg/X.astro': PAGE,
  });
  context.after(() => removeProject(built.root));
  const source = path.join(built.root, 'pages/site/src');
  const pagesDirectory = path.join(source, 'pages');
  const listed = listAstroFiles(source, { pagesDirectory }).map((file) => path.relative(source, file).split(path.sep).join('/'));
  assert.deepEqual(listed.sort(), ['components/Card.astro', 'pages/about.md', 'pages/index.astro']);
});

test('names that differ only by case are two files on a case-sensitive volume', (context) => {
  if (volumeIsCaseInsensitive()) {
    context.skip('this volume treats Foo.astro and foo.astro as one file; the shape cannot be built here');
    return;
  }
  const built = buildProject({ 'src/components/Foo.astro': PAGE, 'src/components/foo.astro': PAGE });
  context.after(() => removeProject(built.root));
  assert.equal(listAstroFiles(path.join(built.root, 'src')).length, 2);
});

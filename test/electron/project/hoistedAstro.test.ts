// Goal: a site in a workspace whose packages were hoisted to the workspace's root is previewed with the astro
// installed there, and an astro that belongs to something else (above the repository, above the workspace, in the
// home folder) is never run. A project with its own astro answers from its own folder, as before.
// Method: real folders under the system's temporary folder laid out as npm, Yarn, pnpm and Bun leave them, with
// stand-in `.bin` files; the resolver is asked directly, for the platform's shim names too. The dev server's own
// step that finds the command is then driven on a hoisted layout: it must answer without installing anything.
// Nothing is installed or executed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ASTRO_BIN_NAME, buildProject, removeProject, type FixtureFiles } from '../../helpers/projectFixtures.ts';
import { resolveAstroBin } from '#dist/electron/project/projectFiles.js';
import { astroManifestPath, installFolders, usesYarnPlugAndPlay } from '#dist/electron/lib/installFolders.js';
import { DevServers } from '#dist/electron/handlers/devServers.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';

const BIN = `node_modules/.bin/${ASTRO_BIN_NAME}`;
const MANIFEST = 'node_modules/astro/package.json';
const WORKSPACE = '{"private":true,"workspaces":["apps/*"]}';

function project(context: TestContext, files: FixtureFiles): { readonly root: string; readonly at: (relative: string) => string } {
  const built = buildProject(files, 'stacki-hoisted-');
  context.after(() => removeProject(built.root));
  return { root: built.root, at: (relative) => path.join(built.root, ...relative.split('/').filter((part) => part !== '')) };
}

// A home folder that is nowhere near the fixtures, so only the layouts decide.
const AWAY = path.join(path.parse(process.cwd()).root, 'stacki-no-such-home', 'person');

test('npm, Yarn and Bun workspaces: astro hoisted to the root is found from the site', (context) => {
  const { at } = project(context, {
    'package.json': WORKSPACE,
    [BIN]: '#!/bin/sh',
    [MANIFEST]: '{"version":"6.1.0"}',
    'apps/web/package.json': '{}',
    // The preview writes under the site's own node_modules; that is not an install of astro.
    'apps/web/node_modules/.avb/astro.config.mjs': '',
  });
  assert.equal(resolveAstroBin(at('apps/web'), process.platform, AWAY), at(BIN));
  assert.equal(astroManifestPath(at('apps/web'), AWAY), at(MANIFEST));
});

test('the site’s own astro wins over the workspace’s, and a pnpm member has its own', (context) => {
  const { at } = project(context, {
    'pnpm-workspace.yaml': 'packages: [apps/*]',
    [BIN]: '#!/bin/sh',
    'apps/web/package.json': '{}',
    [`apps/web/${BIN}`]: '#!/bin/sh',
    [`apps/web/${MANIFEST}`]: '{}',
  });
  assert.equal(resolveAstroBin(at('apps/web'), process.platform, AWAY), at(`apps/web/${BIN}`));
  assert.equal(astroManifestPath(at('apps/web'), AWAY), at(`apps/web/${MANIFEST}`));
});

test('Windows shim names are found at the workspace root: npm’s .cmd and Bun’s .exe', (context) => {
  const { at } = project(context, {
    'npm/package.json': WORKSPACE,
    'npm/node_modules/.bin/astro.cmd': '@echo off',
    'npm/apps/web/package.json': '{}',
    'bun/package.json': WORKSPACE,
    'bun/node_modules/.bin/astro.exe': 'MZ',
    'bun/apps/web/package.json': '{}',
  });
  assert.equal(resolveAstroBin(at('npm/apps/web'), 'win32', AWAY), at('npm/node_modules/.bin/astro.cmd'));
  assert.equal(resolveAstroBin(at('bun/apps/web'), 'win32', AWAY), at('bun/node_modules/.bin/astro.exe'));
});

test('an astro that belongs to something else is never picked up', (context) => {
  const { at } = project(context, {
    // Above the repository's own folder.
    [`above/${BIN}`]: '#!/bin/sh',
    [`above/${MANIFEST}`]: '{}',
    'above/package.json': WORKSPACE,
    'above/repo/.git/HEAD': 'ref: refs/heads/main',
    'above/repo/site/package.json': '{}',
    // Above a workspace's root.
    'outer/workspace/pnpm-workspace.yaml': 'packages: [site]',
    'outer/workspace/site/package.json': '{}',
    [`outer/${BIN}`]: '#!/bin/sh',
    // Above a site that is no workspace member: npm installs into the site itself.
    'loose/package.json': '{}',
    [`loose/${BIN}`]: '#!/bin/sh',
    'loose/site/package.json': '{}',
    // A linked worktree's `.git` is a file, and is a repository's own folder too.
    'tree/.git': 'gitdir: /somewhere/.git/worktrees/tree',
    'tree/site/package.json': '{}',
  });
  for (const site of ['above/repo/site', 'outer/workspace/site', 'loose/site', 'tree/site']) {
    assert.equal(resolveAstroBin(at(site), process.platform, AWAY), undefined, site);
    assert.equal(astroManifestPath(at(site), AWAY), undefined, site);
  }
});

test('the home folder and everything above it is out of reach, even as a workspace', (context) => {
  const { at } = project(context, {
    'me/package.json': WORKSPACE,
    [`me/${BIN}`]: '#!/bin/sh',
    'me/code/site/astro.config.mjs': '',
  });
  assert.equal(resolveAstroBin(at('me/code/site'), process.platform, at('me')), undefined);
  assert.deepEqual(installFolders(at('me/code/site'), at('me')), [at('me/code/site')]);
});

test('a submodule inside a workspace, and a site with no package.json of its own, still reach their install', (context) => {
  const { at } = project(context, {
    'mono/.git/HEAD': 'ref: refs/heads/main',
    'mono/package.json': WORKSPACE,
    [`mono/${BIN}`]: '#!/bin/sh',
    'mono/apps/sub/.git': 'gitdir: ../../.git/modules/sub',
    'mono/apps/sub/package.json': '{}',
    'single/package.json': '{}',
    [`single/${BIN}`]: '#!/bin/sh',
    'single/website/astro.config.mjs': '',
  });
  assert.equal(resolveAstroBin(at('mono/apps/sub'), process.platform, AWAY), at(`mono/${BIN}`));
  assert.equal(resolveAstroBin(at('single/website'), process.platform, AWAY), at(`single/${BIN}`));
});

test('Yarn Plug’n’Play is recognised within the workspace only', (context) => {
  const { at } = project(context, {
    'pnp/package.json': WORKSPACE,
    'pnp/.pnp.cjs': '',
    'pnp/apps/web/package.json': '{}',
    'plain/package.json': '{}',
  });
  assert.equal(usesYarnPlugAndPlay(at('pnp/apps/web'), AWAY), true);
  assert.equal(usesYarnPlugAndPlay(at('plain'), AWAY), false);
});

test('starting a preview of a hoisted site runs the root’s astro and installs nothing', async (context) => {
  const { at } = project(context, { 'package.json': WORKSPACE, [BIN]: '#!/bin/sh', 'apps/web/package.json': '{}' });
  setToolPathHome(os.homedir());
  const sent: string[] = [];
  const servers = new DevServers({ send: (channel: string) => sent.push(channel) }, () => ({}));
  const installedBin: unknown = Reflect.get(servers, 'installedBin');
  assert.ok(typeof installedBin === 'function');
  const found: unknown = await Reflect.apply(installedBin, servers, [at('apps/web'), () => {}]);
  assert.equal(found, at(BIN));
  assert.deepEqual(sent, [], 'no install, so no progress line');
  assert.equal(fs.existsSync(at('apps/web/node_modules')), false);
});

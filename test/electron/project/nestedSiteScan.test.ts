// Goal: picking a folder that holds Astro sites, however it is laid out, offers those sites; a package that merely
// uses astro is not called a site; a folder that opens as a project today still opens at once, with no search; and
// the walk stays inside its bounds and inside the picked folder.
// Method: real folders under the system's temporary folder, one per layout (pnpm, npm, Yarn and Bun workspaces,
// no workspace file at all, deep and oddly named folders, several sites, none), asked through `folderOpenChoice`,
// the function every way of opening a folder ends in. A search that records its calls stands in where the question
// is whether it ran. Bounds are driven with small limits and a clock the test moves. Nothing is installed or run.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as path from 'node:path';
import { ASTRO_BASE, buildProject, removeProject, type FixtureFiles } from '../../helpers/projectFixtures.ts';
import { folderOpenChoice, type NestedSiteSearch } from '#dist/electron/project/folderOpen.js';
import { NESTED_SCAN_LIMITS, nestedSitesSliced } from '#dist/electron/project/nestedSiteScan.js';
import { runSliced, runSync } from '#dist/electron/lib/slicedWork.js';
import { NESTED_SITE_LIMITS, parseSiteFolderChoice } from '#dist/shared/ipc/astroCopy.js';

const PAGE = '<h1>Home</h1>\n';
const CONFIG = 'export default {};\n';
const json = (value: unknown): string => JSON.stringify(value);
const SITE_MANIFEST = json({ name: 'web', scripts: { dev: 'astro dev' }, dependencies: { astro: '^5.0.0' } });

/** A site as `npm create astro` leaves one, under `folder`. */
function site(folder: string, name = 'web'): FixtureFiles {
  return {
    [`${folder}/package.json`]: json({ name, scripts: { dev: 'astro dev' }, dependencies: { astro: '^5.0.0' } }),
    [`${folder}/astro.config.mjs`]: CONFIG,
    [`${folder}/src/pages/index.astro`]: PAGE,
  };
}

function project(context: TestContext, files: FixtureFiles): string {
  const built = buildProject(files, 'stacki-nested-');
  context.after(() => removeProject(built.root));
  return built.root;
}

const searchHere: NestedSiteSearch = (folder) => runSliced(nestedSitesSliced(folder));

async function choose(root: string) {
  const choice = await folderOpenChoice(root);
  // Every answer is one the renderer's parser accepts: both sides of the channel hold the same contract.
  if (choice.kind !== 'rejected') {
    assert.deepEqual(parseSiteFolderChoice(structuredClone(choice)), choice);
  }
  return choice;
}

async function offered(root: string): Promise<readonly string[]> {
  const choice = await choose(root);
  assert.equal(choice.kind, 'nestedSites', JSON.stringify(choice));
  assert.ok(choice.kind === 'nestedSites');
  for (const found of choice.sites) {
    assert.equal(found.projectPath, path.join(root, ...found.relative.split('/')));
  }
  return choice.sites.map((found) => found.relative);
}

const PNPM_MONOREPO: FixtureFiles = {
  'package.json': json({ name: 'acme', private: true, scripts: { dev: 'turbo dev' }, devDependencies: { turbo: '2' } }),
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  'turbo.json': '{}',
  'apps/studio/package.json': json({ name: 'studio', dependencies: { sanity: '3', react: '19' } }),
  'apps/studio/sanity.config.ts': CONFIG,
  ...site('apps/web'),
  'docs/README.md': '# docs',
  'scripts/seed.ts': '',
};

test('the root of a pnpm monorepo offers the one site inside it', async (context) => {
  const root = project(context, PNPM_MONOREPO);
  const choice = await choose(root);
  assert.deepEqual(choice, {
    kind: 'nestedSites',
    folderPath: root,
    sites: [{ projectPath: path.join(root, 'apps', 'web'), relative: 'apps/web', name: 'web' }],
    searched: 'all',
    instead: { kind: 'nothing' },
  });
});

test('npm, Yarn and Bun workspaces and a repository with no workspace file all find their sites', async (context) => {
  const layouts: ReadonlyArray<readonly [string, FixtureFiles, readonly string[]]> = [
    ['npm', { 'package.json': json({ workspaces: ['packages/*'] }), 'package-lock.json': '{}', ...site('packages/marketing') }, ['packages/marketing']],
    ['yarn', { 'package.json': json({ workspaces: { packages: ['sites/*'] } }), 'yarn.lock': '', ...site('sites/blog') }, ['sites/blog']],
    ['bun', { 'package.json': json({ workspaces: ['frontend'] }), 'bun.lock': '{}', ...site('frontend') }, ['frontend']],
    ['no workspace file', { 'api/server.js': '', ...site('website') }, ['website']],
    [
      'deep and oddly named',
      { ...site('Clients (2024)/ACME & Co/Ünïcode “quoted” folder/the site v2/live/front end') },
      ['Clients (2024)/ACME & Co/Ünïcode “quoted” folder/the site v2/live/front end'],
    ],
    ['folders named like build output', { ...site('build'), ...site('apps/dist'), ...site('public') }, ['build', 'public', 'apps/dist']],
    ['workspace globs that miss the site', { 'pnpm-workspace.yaml': 'packages:\n  - libs/*\n', ...site('elsewhere/site') }, ['elsewhere/site']],
  ];
  for (const [what, files, expected] of layouts) {
    assert.deepEqual(await offered(project(context, files)), expected, what);
  }
});

test('a site is known by what it holds: a config, pages, or a script that runs it', async (context) => {
  const root = project(context, {
    // A custom srcDir has a config and no src/pages at all.
    'custom/astro.config.ts': 'export default { srcDir: "./app" };',
    'custom/app/pages/index.astro': PAGE,
    // No page yet: the config alone.
    'configured/astro.config.cjs': 'module.exports = {};',
    // No page and no config yet: a script that runs the site from here.
    'fresh/package.json': json({ name: 'fresh', scripts: { dev: 'cross-env A=1 astro dev --port 3000' }, devDependencies: { astro: '5' } }),
    // Pages and no package.json.
    'bare/src/pages/index.astro': PAGE,
    // Markdown pages only, with astro among the dependencies.
    'notes/package.json': json({ dependencies: { astro: '5' } }),
    'notes/src/pages/blog/post.md': '# post',
    // Pages only in folders below src/pages.
    'localized/package.json': json({ peerDependencies: { astro: '5' } }),
    'localized/src/pages/[lang]/index.astro': PAGE,
  });
  assert.deepEqual(await offered(root), ['bare', 'configured', 'custom', 'fresh', 'localized', 'notes']);
});

test('depending on astro does not make a package a site', async (context) => {
  const root = project(context, {
    'package.json': json({ workspaces: ['packages/*'] }),
    'packages/integration/package.json': json({
      name: 'astro-thing',
      scripts: { build: 'tsc', test: 'astro check' },
      peerDependencies: { astro: '5' },
      devDependencies: { astro: '5' },
    }),
    'packages/integration/src/index.ts': '',
    'packages/components/package.json': json({ name: 'ui', dependencies: { astro: '5' }, exports: './src/index.ts' }),
    'packages/components/src/components/Card.astro': PAGE,
    // Its script starts a site that lives somewhere else.
    'packages/runner/package.json': json({ scripts: { dev: 'astro dev --root ../../site' }, devDependencies: { astro: '5' } }),
    // A peer dependency with a demo script is still a plugin.
    'packages/plugin/package.json': json({ scripts: { dev: 'astro dev' }, peerDependencies: { astro: '5' } }),
    // Another framework's pages folder.
    'packages/next/package.json': json({ dependencies: { next: '15' } }),
    'packages/next/src/pages/index.tsx': '',
    'broken/package.json': '{ nope',
    'huge/package.json': `{"scripts":{"dev":"astro dev"},"dependencies":{"astro":"5"},"pad":"${'x'.repeat(NESTED_SCAN_LIMITS.manifestBytesMax)}"}`,
  });
  assert.deepEqual(await choose(root), { kind: 'notWebsite', folderPath: root, searched: 'all' });
});

test('a workspace root that only lists astro offers the real site, and itself as before', async (context) => {
  const root = project(context, {
    'package.json': json({ name: 'mono', workspaces: ['apps/*'], devDependencies: { astro: '5' }, scripts: { dev: 'astro dev --root apps/web' } }),
    ...site('apps/web'),
  });
  const choice = await choose(root);
  assert.ok(choice.kind === 'nestedSites');
  assert.deepEqual(
    choice.sites.map((found) => found.relative),
    ['apps/web'],
  );
  assert.deepEqual(choice.instead, { kind: 'openFolder' });
});

test('a folder that only lists astro and holds no other site opens as it always has', async (context) => {
  const root = project(context, {
    'package.json': json({ dependencies: { astro: '5' } }),
    'src/components/Card.astro': PAGE,
    'README.md': '',
  });
  assert.deepEqual(await choose(root), { kind: 'astro', projectPath: root });
});

test('several sites are all offered, sample folders last, and none is left out for its name', async (context) => {
  const root = project(context, {
    'package.json': json({ private: true }),
    ...site('examples/starter', '{{name}}'),
    ...site('apps/web'),
    ...site('apps/docs', 'documentation'),
    ...site('marketing'),
    ...site('packages/theme/test/fixtures/basic', 'basic'),
    ...site('templates/blog', 'blog'),
  });
  assert.deepEqual(await offered(root), ['marketing', 'apps/docs', 'apps/web', 'examples/starter', 'templates/blog', 'packages/theme/test/fixtures/basic']);
});

test('a site that holds other sites inside is offered once, and a root that is a site opens at once', async (context) => {
  const outer = project(context, { ...site('app'), ...site('app/examples/inner') });
  assert.deepEqual(await offered(outer), ['app']);
  const own = project(context, { ...ASTRO_BASE, 'astro.config.mjs': CONFIG, ...site('docs') });
  assert.deepEqual(await choose(own), { kind: 'astro', projectPath: own });
});

test('a monorepo with stray HTML files offers its Astro site first and keeps the copy on offer', async (context) => {
  const root = project(context, { ...PNPM_MONOREPO, 'coverage.html': '<p>report</p>' });
  const choice = await choose(root);
  assert.ok(choice.kind === 'nestedSites');
  assert.deepEqual(
    choice.sites.map((found) => found.relative),
    ['apps/web'],
  );
  assert.equal(choice.instead.kind, 'plainWebsite');
  assert.ok(choice.instead.kind === 'plainWebsite');
  assert.equal(choice.instead.offer.sourcePath, root);
});

test('a plain website and an empty folder answer as before', async (context) => {
  const plain = project(context, { 'index.html': '<p>x</p>', 'css/site.css': '', 'node_modules/pkg/astro.config.mjs': CONFIG });
  assert.equal((await choose(plain)).kind, 'plainWebsite');
  const empty = project(context, { 'README.md': '' });
  assert.deepEqual(await choose(empty), { kind: 'notWebsite', folderPath: empty, searched: 'all' });
});

test('installed packages, hidden folders and the insides of build output are never searched', async (context) => {
  const root = project(context, {
    ...site('node_modules/theme'),
    ...site('apps/x/node_modules/theme'),
    ...site('bower_components/theme'),
    ...site('.git/theme'),
    ...site('.stacki/preview'),
    ...site('.cache/site'),
    ...site('dist/copied'),
    ...site('build/server/copied'),
    ...site('coverage/copied'),
    ...site('Library.photoslibrary/site'),
  });
  assert.deepEqual(await choose(root), { kind: 'notWebsite', folderPath: root, searched: 'all' });
});

test('links to folders are never followed: a loop ends and nothing outside the folder is offered', async (context) => {
  const outside = project(context, site('private-site'));
  const root = project(context, {
    'a/readme.md': '',
    'a/loop': { symlink: '..' },
    'a/self': { symlink: '.' },
    outside: { symlink: outside },
    // A link standing in for src/pages is not read either.
    'linked-pages/src/pages': { symlink: path.join(outside, 'private-site', 'src', 'pages') },
  });
  assert.deepEqual(await choose(root), { kind: 'notWebsite', folderPath: root, searched: 'all' });
});

test('a folder that cannot be read is skipped, and the answer says part was not searched', async (context) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    context.skip('permissions cannot be taken away here');
    return;
  }
  const root = project(context, { ...site('open'), locked: { directory: true, mode: 0 } });
  const scan = runSync(nestedSitesSliced(root));
  assert.deepEqual(
    scan.sites.map((found) => found.relative),
    ['open'],
  );
  assert.equal(scan.searched, 'part');
});

test('every bound stops the walk and says so', (context) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 40; index += 1) {
    files[`many/folder-${String(index).padStart(2, '0')}/note.txt`] = '';
  }
  const root = project(context, { ...files, ...site('zzz/deeper/site') });
  const scan = (name: keyof typeof NESTED_SCAN_LIMITS, value: number, now: () => number = () => 0) =>
    runSync(nestedSitesSliced(root, { limits: { ...NESTED_SCAN_LIMITS, [name]: value }, now }));
  const whole = scan('depthMax', NESTED_SCAN_LIMITS.depthMax);
  assert.deepEqual([whole.sites.length, whole.searched], [1, 'all']);
  assert.deepEqual(scan('depthMax', 2), { sites: [], searched: 'part' }, 'depth');
  assert.deepEqual(scan('foldersMax', 10), { sites: [], searched: 'part' }, 'folders');
  assert.deepEqual(scan('entriesMax', 20), { sites: [], searched: 'part' }, 'entries');
  let clockMs = 0;
  const ticking = () => (clockMs += 1_000);
  assert.deepEqual(scan('timeMsMax', NESTED_SCAN_LIMITS.timeMsMax, ticking), { sites: [], searched: 'part' }, 'time');
});

test('more sites than one answer names are cut to the limit and called part', async (context) => {
  let files: FixtureFiles = {};
  for (let index = 0; index <= NESTED_SITE_LIMITS.sitesMax; index += 1) {
    files = { ...files, [`sites/s${String(index).padStart(2, '0')}/astro.config.mjs`]: CONFIG };
  }
  const choice = await choose(project(context, files));
  assert.ok(choice.kind === 'nestedSites');
  assert.equal(choice.sites.length, NESTED_SITE_LIMITS.sitesMax);
  assert.equal(choice.searched, 'part');
});

test('the home folder and any folder that holds it are not walked', (context) => {
  const root = project(context, { ...site('people/me/project') });
  for (const homePath of [root, path.join(root, 'people', 'me')]) {
    assert.deepEqual(runSync(nestedSitesSliced(root, { homePath })), { sites: [], searched: 'part' });
  }
  assert.equal(runSync(nestedSitesSliced(root, { homePath: path.join(root, 'elsewhere', '..', '..') + '-x' })).sites.length, 1);
});

test('the walk yields after every folder, so the window keeps its turn', (context) => {
  const root = project(context, PNPM_MONOREPO);
  const work = nestedSitesSliced(root);
  let steps = 0;
  while (work.next().done !== true) {
    steps += 1;
    assert.ok(steps < 100);
  }
  assert.ok(steps >= 5, `one step a folder, got ${steps}`);
});

// The people who open one project: nothing about opening it may change.
const NORMAL_PROJECTS: ReadonlyArray<readonly [string, FixtureFiles, string]> = [
  ['a new project', { ...ASTRO_BASE, 'astro.config.mjs': CONFIG }, ''],
  ['dependency and pages, no config', ASTRO_BASE, ''],
  ['no pages yet, a config', { 'package.json': SITE_MANIFEST, 'astro.config.mjs': CONFIG }, ''],
  ['only a config', { 'astro.config.ts': CONFIG }, ''],
  ['each other config name', { 'astro.config.mts': CONFIG }, ''],
  ['a CommonJS config', { 'astro.config.cjs': CONFIG }, ''],
  ['a peer dependency with a config', { 'package.json': json({ peerDependencies: { astro: '5' } }), 'astro.config.js': CONFIG }, ''],
  ['pages and nothing else', { 'src/pages/index.astro': PAGE }, ''],
  ['no pages or config yet, a script that runs it', { 'package.json': SITE_MANIFEST }, ''],
  ['an empty pages folder', { 'package.json': json({ dependencies: { astro: '5' } }), 'src/pages': { directory: true } }, ''],
  ['a site with a site inside', { ...ASTRO_BASE, ...site('examples/inner') }, ''],
  [
    'a workspace member under a root that lists astro',
    { 'package.json': json({ dependencies: { astro: '5' } }), 'apps/web/src/pages/index.md': '' },
    'apps/web',
  ],
  ['a workspace member of a pnpm monorepo', PNPM_MONOREPO, 'apps/web'],
];

test('a folder that opens as a project is never searched', async (context) => {
  for (const [what, files, picked] of NORMAL_PROJECTS) {
    const folder = path.join(project(context, files), ...picked.split('/').filter((part) => part !== ''));
    const searched: string[] = [];
    const choice = await folderOpenChoice(folder, undefined, async (asked) => {
      searched.push(asked);
      return searchHere(asked);
    });
    assert.deepEqual(choice, { kind: 'astro', projectPath: folder }, what);
    assert.deepEqual(searched, [], what);
  }
});

test('the search runs only for a folder that would not open, or that merely lists astro', async (context) => {
  const cases: ReadonlyArray<readonly [string, FixtureFiles]> = [
    ['a monorepo root', PNPM_MONOREPO],
    ['a plain website', { 'index.html': '' }],
    ['a root that only lists astro', { 'package.json': json({ dependencies: { astro: '5' } }) }],
  ];
  for (const [what, files] of cases) {
    let calls = 0;
    await folderOpenChoice(project(context, files), undefined, async () => {
      calls += 1;
      return { sites: [], searched: 'all' };
    });
    assert.equal(calls, 1, what);
  }
});

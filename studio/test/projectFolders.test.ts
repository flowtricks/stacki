// Goal: Studio's scanners read the same `.stacki/folders.json` Desktop does: with
// no file they list what they always listed, and with one the components,
// layouts, assets and stylesheets come from the chosen folders; asset writes
// outside the chosen folders are refused.
// Method: build disposable projects on disk, run the real Studio scan, asset
// catalog, asset operations and stylesheet listing, and parse the asset listing
// with the renderer's shared parser so both editors accept the same shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject } from '../src/features/project/projectServer';
import { assetCatalog } from '../src/features/assets/assetCatalog';
import { mutateAsset } from '../src/features/assets/assetOperations';
import { assetFolderPath } from '../src/features/assets/assetFolders';
import { styleFiles } from '../src/features/settings/styleRoutes';
import { parseAssetListing } from '../vendor/stacki/src/features/assets/assetPanelBridge';
import { checkProject } from '../scripts/checkProject';
import { cmsFixture } from './cmsFixture';
import { parseCmsFiles } from '../vendor/stacki/src/features/cms/cmsPanelBridge';
import { metadataFiles } from '../src/features/settings/projectMetadata';

const SITE: Readonly<Record<string, string>> = {
  'package.json': '{"dependencies":{"astro":"*"}}',
  'src/pages/index.astro': '<h1>Home</h1>',
  'src/components/Card.astro': '<div class="card" />',
  'src/layouts/Base.astro': '<slot />',
  'src/ui/Button.astro': '<button class="button" />',
  'src/shells/Shell.astro': '<slot />',
  'src/assets/hero.png': 'png',
  'src/media/logo.svg': '<svg />',
  'src/styles/global.css': '.global {}',
  'src/components/card.css': '.lonely {}',
  'public/favicon.ico': 'ico',
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-folders-'));
  for (const [relative, text] of Object.entries(SITE)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  await mkdir(path.join(root, '.stacki/studio/state'), { recursive: true });
  await writeFile(path.join(root, '.stacki/studio/state/github-base.json'), JSON.stringify({ sha: 'a'.repeat(40) }));
  return root;
}
const writeFolders = (root: string, folders: unknown) => writeFile(path.join(root, '.stacki/folders.json'), JSON.stringify({ version: 1, folders }));

test('components and layouts: every .astro outside src/pages without settings, the chosen folders with them', async () => {
  const root = await fixture();
  try {
    const before = await scanProject(root);
    assert.deepEqual(before.components.map((component) => component.file).sort(), [
      'src/components/Card.astro',
      'src/layouts/Base.astro',
      'src/shells/Shell.astro',
      'src/ui/Button.astro',
    ]);
    assert.deepEqual(
      before.components.filter((component) => component.isLayout === true).map((component) => component.file),
      ['src/layouts/Base.astro'],
    );
    await writeFolders(root, { components: ['src/ui'], layouts: ['src/shells'] });
    const after = await scanProject(root);
    assert.deepEqual(after.components.map((component) => component.file).sort(), ['src/shells/Shell.astro', 'src/ui/Button.astro']);
    assert.equal(after.components.find((component) => component.file === 'src/shells/Shell.astro')?.isLayout, true);
    assert.equal(after.components.find((component) => component.file === 'src/ui/Button.astro')?.folder, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assets: both roots without settings, only the chosen folders with them, and writes stay inside', async () => {
  const root = await fixture();
  try {
    const files = async () =>
      parseAssetListing(await assetCatalog(root))
        .entries.filter((entry) => !entry.isDir)
        .map((entry) => entry.rel)
        .sort();
    assert.deepEqual(await files(), ['public/favicon.ico', 'src/assets/hero.png', 'src/media/logo.svg']);
    await writeFolders(root, { assets: ['src/assets'] });
    const listing = parseAssetListing(await assetCatalog(root));
    assert.equal(listing.missing, true, 'no public folder is listed');
    assert.deepEqual(await files(), ['src/assets/hero.png']);
    assert.ok(
      listing.entries.some((entry) => entry.rel === 'src' && entry.isDir),
      'the root leads to the folder',
    );
    assert.equal(assetFolderPath(root, 'src/assets/new.png'), 'src/assets/new.png');
    assert.throws(() => assetFolderPath(root, 'src/media/new.png'), /not in one of the project's asset folders/);
    await assert.rejects(mutateAsset(root, { kind: 'delete', rel: 'src/media/logo.svg' }), /not in one of the project's asset folders/);
    await assert.rejects(mutateAsset(root, { kind: 'move', rel: 'src/assets/hero.png', destination: 'src/media' }), /not in one/);
    await assert.rejects(mutateAsset(root, { kind: 'mkdir', rel: 'src', name: 'elsewhere' }), /not in one/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stylesheets: src and public without settings, the chosen style folders with them', async () => {
  const root = await fixture();
  try {
    const rels = async () => (await styleFiles(root, false)).files.map((file) => file.rel);
    assert.deepEqual(
      await rels(),
      ['src/styles/global.css', 'src/components/card.css'].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
    );
    await writeFolders(root, { styles: ['src/styles'] });
    assert.deepEqual(await rels(), ['src/styles/global.css']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check-project and the metadata inventory accept a folders file, keep one from a newer Stacki, and refuse a bad one', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  // check-project prints its report; keep the test output to the test's own lines.
  context.mock.method(console, 'log', () => undefined);
  await checkProject(root);
  await writeFile(path.join(root, '.stacki/folders.json'), JSON.stringify({ version: 1, theme: 'dark', folders: { widgets: ['x'], styles: ['src/styles'] } }));
  await checkProject(root);
  assert.deepEqual(await metadataFiles(root), ['.stacki/folders.json']);
  await writeFolders(root, { components: ['../outside'] });
  await assert.rejects(checkProject(root), /cannot step out/);
});

test('the CMS panel lists the chosen data files in Studio too, and detects them without settings', async () => {
  const fixture = await cmsFixture({
    'src/consts.ts': "export const SITE_TITLE = 'Site';\nexport const LINKS = [{ label: 'Home', href: '/' }];\n",
    'src/lib/settings.ts': "export const THEME = 'dark';\n",
    'src/components/Hero.astro': "---\nconst slides = [{ title: 'One' }];\n---\n<div />\n",
    'src/pages/example-components.astro': "---\nconst items = [{ name: 'A' }];\n---\n<div />\n",
  });
  try {
    const listed = async () => [...new Set(parseCmsFiles((await fixture.post('cms:list', 'studio'))['value']).map((file) => file.rel.split('#')[0]))].sort();
    // Studio's own detection lists every data module's single values (cmsPaths.ts), as it always has.
    assert.deepEqual(await listed(), ['components/Hero.astro', 'consts.ts', 'lib/settings.ts', 'pages/example-components.astro']);
    await mkdir(path.join(fixture.root, '.stacki'), { recursive: true });
    await writeFile(
      path.join(fixture.root, '.stacki/folders.json'),
      JSON.stringify({ version: 1, cms: { files: ['src/components/Hero.astro', 'src/lib/settings.ts'] } }),
    );
    assert.deepEqual(
      await listed(),
      ['components/Hero.astro', 'lib/settings.ts', 'pages/example-components.astro'],
      'a listed file is present, a removed one absent, Astro files always',
    );
  } finally {
    await fixture.close();
  }
});

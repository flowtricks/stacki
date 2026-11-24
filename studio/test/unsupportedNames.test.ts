// Goal: one file Studio cannot edit must not stop a project from opening. Studio accepts a
// narrow set of path characters, and ordinary sites carry names outside it (`logo@2x.png`,
// `Card (old).astro`) or stylesheets past the editing limit (minified vendor CSS).
// Method: scan a real temporary project holding such files, parse the answers with the
// client's own parser, and check that the files stay refused for editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readSource, safePath, scanProject } from '../src/features/project/projectServer';
import { parseProject } from '../src/features/project/projectClient';
import { assetCatalog } from '../src/features/assets/assetCatalog';
import { styleFiles } from '../src/features/settings/styleRoutes';
import { saveAsset } from '../src/features/storage/assetStorage';
import { MAX_SOURCE } from '../src/shared/validation';

async function project(files: Readonly<Record<string, string>>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-names-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SITE = {
  'src/pages/index.astro': '<main class="kept"></main>\n',
  'src/pages/über.astro': '<main></main>\n',
  'src/components/Card.astro': '<div></div>\n',
  'src/components/Card (old).astro': '<div></div>\n',
  'src/styles/site.css': '.small { color: red }\n',
  'public/logo.png': 'png',
  'public/logo@2x.png': 'png',
  'src/pages/(old)/draft.astro': '<main></main>\n',
  'public/vendor/theme@2x.css': '.odd { color: red }\n',
  'public/vendor/bundle.min.css': '.huge{}'.padEnd(MAX_SOURCE + 1, ' '),
};

test('a project with unsupported names and an oversized stylesheet still opens', async () => {
  await project(SITE, async (root) => {
    const scan = parseProject(await scanProject(root));
    assert.deepEqual(scan.pages, ['src/pages/index.astro']);
    assert.deepEqual(
      scan.components.map((component) => component.file),
      ['src/components/Card.astro'],
    );
    assert.ok(scan.classes.includes('small'));
    assert.ok(!scan.classes.includes('huge'));
    assert.ok(!scan.classes.includes('odd'));
  });
});

test('the asset and stylesheet lists keep the files Studio can open', async () => {
  await project(SITE, async (root) => {
    const assets = await assetCatalog(root);
    assert.deepEqual(
      assets.entries.filter((entry) => !entry.isDir).map((entry) => entry.rel),
      ['public/logo.png'],
    );
    const styles = await styleFiles(root, false);
    assert.deepEqual(
      styles.files.map((file) => file.rel),
      ['public/vendor/bundle.min.css', 'src/styles/site.css'],
    );
  });
});

test('an upload saves beside a file Studio cannot open', async () => {
  await project({ 'public/logo@2x.png': 'png' }, async (root) => {
    await saveAsset(root, 'public/new.png', Buffer.from('new'));
    assert.equal(await readFile(path.join(root, 'public/new.png'), 'utf8'), 'new');
  });
});

test('unsupported names and oversized files stay refused for editing', async () => {
  await project(SITE, async (root) => {
    await assert.rejects(() => safePath(root, 'public/logo@2x.png'), /Invalid project path/);
    await assert.rejects(() => saveAsset(root, 'public/new@2x.png', Buffer.from('new')), /Invalid project path/);
    await assert.rejects(() => readSource(root, 'public/vendor/bundle.min.css'), /1 MB/);
  });
});

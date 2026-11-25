// Real temporary projects distinguish installed editor styles from website styles.
// Both stylesheet and global Astro scans must exclude Studio, while ordinary
// studio folders and project variables with editor-like names remain available.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCssFiles, listAstroStyleFiles } from '#dist/electron/project/styleFiles.js';

async function writeFixture(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test('style inventories exclude Studio and preserve website variables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-style-files-'));
  try {
    await writeFixture(root, 'src/styles/base.css', ':root { --component-green: lime; }');
    await writeFixture(root, 'public/theme.css', ':root { --brand: blue; }');
    await writeFixture(root, 'styles/extra.scss', '$color: red;');
    await writeFixture(root, 'src/Layout.astro', '<style is:global>:root { --gap: 1rem; }</style>');
    for (const directory of ['studio', 'src/studio']) {
      await writeFixture(root, `${directory}/package.json`, '{"name":"@stacki/studio"}');
      await writeFixture(root, `${directory}/vendor/stacki/src/app/styles.css`, ':root { --component-green: #79e09c; --collection-purple: #c4afff; }');
      await writeFixture(root, `${directory}/src/App.astro`, '<style is:global>html { color: red; }</style>');
    }
    assert.deepEqual(
      listCssFiles(root).map((file) => file.rel),
      ['public/theme.css', 'styles/extra.scss', 'src/styles/base.css'],
    );
    assert.deepEqual(
      listAstroStyleFiles(root).map((file) => file.rel),
      ['src/Layout.astro'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary studio folders survive missing, invalid and unrelated metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-style-folder-'));
  try {
    await writeFixture(root, 'src/studio/theme.css', ':root { --brand: blue; }');
    await writeFixture(root, 'src/studio/Layout.astro', '<style is:global>html { color: blue; }</style>');
    const manifests = [undefined, '{', 'null', '[]', '{"name":42}', '{"name":"website-studio"}', ' '.repeat(64 * 1024 + 1)];
    for (const manifest of manifests) {
      if (manifest !== undefined) {
        await writeFixture(root, 'src/studio/package.json', manifest);
      }
      assert.deepEqual(
        listCssFiles(root).map((file) => file.rel),
        ['src/studio/theme.css'],
      );
      assert.deepEqual(
        listAstroStyleFiles(root).map((file) => file.rel),
        ['src/studio/Layout.astro'],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the stylesheet list stays out of unrelated root folders', async () => {
  // A backup or download folder beside the site is not the site's CSS, and a
  // large one stalled the synchronous walk (issue #67).
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-style-roots-'));
  try {
    await writeFixture(root, 'root.css', 'body { margin: 0; }');
    await writeFixture(root, 'src/styles/base.css', 'body { color: red; }');
    await writeFixture(root, 'TEMP/joomla/templates/site.css', 'body { color: blue; }');
    await writeFixture(root, 'TEMP/deep/a/b/c/d.css', 'body { color: green; }');
    assert.deepEqual(
      listCssFiles(root).map((file) => file.rel),
      ['root.css', 'src/styles/base.css'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

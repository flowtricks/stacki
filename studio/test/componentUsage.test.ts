import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanComponentUsage } from '../src/features/components/componentUsageServer';

test('Stacki counts and usage agree across aliases, duplicates, layouts and markdown pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-usage-'));
  try {
    const files: Readonly<Record<string, string>> = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'src/components/Card.astro': `---\nimport Card from './Card.astro';\n---\n<Card /><slot />`,
      'src/components/other/Card.astro': '<slot />',
      'src/components/Unused.astro': '<div />',
      'src/pages/index.astro': `---\nimport Tile from '@/components/Card.astro';\nconst example = '<Tile />';\n---\n<Tile /><Tile></Tile>`,
      'src/pages/other.astro': `---\nimport Card from '../components/other/Card.astro';\n---\n<Card />`,
      'src/layouts/Base.astro': `---\nimport Tile from '../components/Card.astro';\n---\n<Tile /><slot />`,
      'src/pages/guide.mdx': `import Tile from '../components/Card.astro';\n<Tile />`,
      'src/pages/legacy.md': '<Card />',
      'src/content/ignored.md': '<Card />',
    };
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    const results = await scanComponentUsage(root);
    const card = results.find((result) => result.file === 'src/components/Card.astro');
    assert.ok(card);
    assert.equal(card.total, 5);
    assert.equal(
      card.files.reduce((sum, file) => sum + file.count, 0),
      card.total,
    );
    assert.equal(card.files[0]?.rel, 'src/pages/index.astro');
    assert.equal(card.files[0]?.count, 2);
    assert.equal(
      card.files.some((file) => file.rel === card.file),
      false,
    );
    assert.equal(
      card.files.some((file) => path.isAbsolute(file.path)),
      false,
    );
    assert.equal(results.find((result) => result.file.endsWith('/Unused.astro'))?.total, 0);
    assert.equal(results.find((result) => result.file.endsWith('/other/Card.astro'))?.total, 2);
    assert.deepEqual(await scanComponentUsage(root, card.file), [card]);
    await writeFile(path.join(root, 'src/pages/guide.mdx'), files['src/pages/guide.mdx'] + '\n<Tile />');
    assert.equal((await scanComponentUsage(root, card.file))[0]?.total, 6);
    await assert.rejects(scanComponentUsage(root, '../../outside.astro'), /Select a component/);
    await symlink(path.join(root, 'src/components/Card.astro'), path.join(root, 'src/components/Link.astro'));
    await assert.rejects(scanComponentUsage(root, 'src/components/Link.astro'), /Select a component/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

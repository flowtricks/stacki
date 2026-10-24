// Verify filesystem boundaries, content preservation, and safe AI/source discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { preparePath, safePath } from '../src/features/project/projectServer';
import { collectionContent } from '../src/features/collections/content';
import { componentSchema } from '../src/features/components/componentSchema';
import { resolveImport, relativeImport } from '../src/features/source/imports';
import { proposedSource } from '../src/features/ai/agent';

test('nested creation works while symlink and traversal writes are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'studio-outside-'));
  try {
    const destination = await preparePath(root, 'src/content/posts/hello.md');
    await writeFile(destination, 'hello');
    assert.equal(await readFile(destination, 'utf8'), 'hello');
    await symlink(outside, path.join(root, 'src/escape'));
    await assert.rejects(() => safePath(root, 'src/escape/secret.json'), /Symbolic links/);
    await assert.rejects(() => preparePath(root, 'src/../outside.json'), /Invalid/);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
test('collection JSON edits preserve neighboring formatting; Markdown edits preserve body', () => {
  const json = '{ "title": "Before",\n  "other": [1, 2] }\n';
  const edited = collectionContent('item.json', json).change('title', 'After');
  assert.equal(edited, json.replace('Before', 'After'));
  const md = '---\ntitle: Before\n# Keep me\npublished: true\n---\n\nBody **untouched**\n';
  const parsed = collectionContent('post.md', md);
  const after = parsed.change('title', 'After');
  assert.ok(after.includes('# Keep me'));
  assert.ok(after.endsWith('\n\nBody **untouched**\n'));
  assert.equal(collectionContent('post.md', after).fields['title'], 'After');
});
test('AI proposals reject stale, ambiguous, and oversized replacements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-ai-'));
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Hello</h1>\n<p>Hello</p>');
    await assert.rejects(
      () =>
        proposedSource(root, { file: 'src/pages/index.astro', before: 'Hello', after: 'Changed' }),
      /ambiguous/,
    );
    await assert.rejects(
      () =>
        proposedSource(root, {
          file: 'src/pages/index.astro',
          before: 'Missing',
          after: 'Changed',
        }),
      /stale/,
    );
    assert.equal(
      await proposedSource(root, {
        file: 'src/pages/index.astro',
        before: '<h1>Hello</h1>',
        after: '<h1>Changed</h1>',
      }),
      '<h1>Changed</h1>\n<p>Hello</p>',
    );
    await assert.rejects(
      () =>
        proposedSource(root, {
          file: 'src/pages/new.astro',
          before: '',
          after: 'x'.repeat(1_000_001),
        }),
      /Invalid string/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('component schemas resolve imported aliases and skip non-source asset imports', async () => {
  const source = `---
import { ButtonContent as Content } from './schema';
import icon from '@/assets/icon.svg';
import badge from '@/assets/badge.svg?url';
import raw from './template.html?raw';
import fragment from '@/assets/icons.svg#arrow';
type Props = Content;
const { label, enabled = true } = Astro.props;
---
<button>{label}</button>`;
  const fields = await componentSchema('src/components/Button.astro', source, async (file) => {
    assert.equal(file, 'src/components/schema.ts');
    return 'export interface ButtonContent { label: string; enabled?: boolean; }';
  });
  assert.ok(fields.some((field) => field.name === 'label' && field.type === 'string'));
  assert.ok(fields.some((field) => field.name === 'enabled' && field.type === 'boolean'));
  assert.equal(
    resolveImport('src/pages/blog/index.astro', '../../components/Button.astro'),
    'src/components/Button.astro',
  );
  assert.equal(
    relativeImport('src/pages/blog/index.astro', 'src/components/Button.astro'),
    '../../components/Button.astro',
  );
});

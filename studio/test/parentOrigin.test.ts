// Goal: a preview frame addresses the editor by the origin the page names, not by its own.
// Method: a stand-in document with and without the meta tag, including an empty one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentOrigin } from '../src/features/preview/parentOrigin';

const documentWith = (content: string | undefined) => ({
  querySelector: () => (content === undefined ? null : { content }),
});

test('the meta origin wins over the frame origin', () => {
  assert.equal(parentOrigin(documentWith('https://editor.example') as never, 'https://preview.example'), 'https://editor.example');
});

test('no meta, or an empty one, falls back to the frame origin', () => {
  assert.equal(parentOrigin(documentWith(undefined) as never, 'https://preview.example'), 'https://preview.example');
  assert.equal(parentOrigin(documentWith('') as never, 'https://preview.example'), 'https://preview.example');
});

test('no preview-frame module posts to its parent with its own origin', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['src/features/bake/staticHot.ts', 'src/features/preview/previewClient.ts']) {
    const source = await readFile(file, 'utf8');
    assert.ok(!/parent\.postMessage\([^;]*location\.origin\)/.test(source.replace(/parentOrigin\(document, location\.origin\)/g, '')), file);
  }
});

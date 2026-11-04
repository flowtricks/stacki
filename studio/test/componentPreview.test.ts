// Exercise shared preview metadata and path selection with source fixtures and temporary files.
// Required data must remain unavailable while authored defaults remain owned by the component.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { componentPreviewInputs, componentPreviewPath, componentPreviewPlugin } from '../vendor/stacki/electron/previewServer/componentPreview';

test('Stacki preview samples guarded labels while preserving authored defaults', async () => {
  const choice = await readFile('test/fixtures/site/src/components/form/Choice.astro', 'utf8');
  assert.deepEqual(componentPreviewInputs(choice, 'Choice').props, { label: 'Choice' });
  const source = `---
type Props = { title?: string; label?: string; render?: boolean; count?: number };
const { title = authoredTitle(), label = '', render = false, count = 0 } = Astro.props;
---
<slot />`;
  assert.deepEqual(componentPreviewInputs(source, 'Card').props, {});
});

test('Stacki preview selects exact component paths and never falls back from invalid paths', () => {
  const paths = ['/src/components/one/Card.astro', '/src/components/two/Card.astro'];
  assert.equal(componentPreviewPath(paths, 'src/components/two/Card.astro', 'Card'), paths[1]);
  for (const file of ['../../Card.astro', 'src/components/missing/Card.astro', 'src/pages/Card.astro']) {
    assert.equal(componentPreviewPath(paths, file, 'Card'), undefined);
  }
  assert.throws(() => componentPreviewPath(paths, 'x'.repeat(4097), 'Card'));
});

test('preview metadata reads current component source and rejects files outside components', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-component-preview-'));
  try {
    await mkdir(path.join(root, 'src/components'), { recursive: true });
    const file = path.join(root, 'src/components/Card.astro');
    const plugin = componentPreviewPlugin([root]);
    await writeFile(file, '---\ntype Props = { label?: string };\n---\n<slot />');
    assert.equal(plugin.load(file + '?raw&stacki-preview-props'), 'export default {"props":{"label":"Card"},"missing":[],"slot":{"kind":"name"}};');
    await writeFile(file, "---\ntype Props = { label?: string };\nconst { label = 'Saved' } = Astro.props;\n---\n<slot />");
    assert.equal(plugin.load(file + '?raw&stacki-preview-props'), 'export default {"props":{},"missing":[],"slot":{"kind":"name"}};');
    await writeFile(file, '---\ninterface Props { data: PageData; }\n---\n<slot />');
    assert.equal(plugin.load(file + '?raw&stacki-preview-props'), 'export default {"props":{},"missing":["data"],"slot":{"kind":"name"}};');
    assert.throws(() => plugin.load(path.join(root, 'src/pages/index.astro?raw&stacki-preview-props')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

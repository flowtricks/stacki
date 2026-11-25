// Exercise shared preview metadata and path selection with source fixtures and temporary files.
// Authored defaults remain owned by the component; required data gets a sample value of its type
// (the render ladder, electron/previewServer/previewAttempts.ts), so nothing is reported missing.
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
    // The module is `export default <JSON>;`: its attempts are drawn best first, and its key changes with the source.
    const metadata = () => {
      const code = plugin.load(file + '?raw&stacki-preview-props');
      assert.ok(typeof code === 'string' && code.startsWith('export default ') && code.endsWith(';'));
      const parsed: unknown = JSON.parse(code.slice('export default '.length, -1));
      assert.ok(typeof parsed === 'object' && parsed !== null);
      const attempts: unknown = Reflect.get(parsed, 'attempts');
      assert.ok(Array.isArray(attempts), 'the attempts are a list');
      const list: readonly unknown[] = attempts;
      assert.ok(list.length > 0, 'a preview always has an attempt');
      const labels = list.map((attempt) => {
        assert.ok(typeof attempt === 'object' && attempt !== null, 'an attempt is an object');
        const label: unknown = Reflect.get(attempt, 'label');
        return label;
      });
      const first = list[0];
      assert.ok(typeof first === 'object' && first !== null);
      const key: unknown = Reflect.get(parsed, 'key');
      const missing: unknown = Reflect.get(parsed, 'missing');
      const props: unknown = Reflect.get(first, 'props');
      return { key, missing, labels, props };
    };
    await writeFile(file, '---\ntype Props = { label?: string };\n---\n<slot />');
    const sampled = metadata();
    assert.deepEqual(sampled.labels, ['sample', 'sample-minimal', 'sample-bare']);
    assert.deepEqual(sampled.props, { label: 'Card' });
    assert.deepEqual(sampled.missing, []);
    await writeFile(file, "---\ntype Props = { label?: string };\nconst { label = 'Saved' } = Astro.props;\n---\n<slot />");
    const authored = metadata();
    assert.deepEqual(authored.props, {}, "an authored default stays the component's own");
    assert.notEqual(authored.key, sampled.key, 'the key follows the current source');
    await writeFile(file, '---\ninterface Props { data: PageData; }\n---\n<slot />');
    const needy = metadata();
    assert.deepEqual(needy.missing, []);
    const data: unknown = typeof needy.props === 'object' && needy.props !== null ? Reflect.get(needy.props, 'data') : undefined;
    assert.ok(typeof data === 'object' && data !== null, 'required data gets a sample value');
    assert.throws(() => plugin.load(path.join(root, 'src/pages/index.astro?raw&stacki-preview-props')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

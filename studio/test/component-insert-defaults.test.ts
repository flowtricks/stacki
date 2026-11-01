import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject } from '../src/features/project/projectServer';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits } from '../src/features/source/source';
import { pastePlacement } from '../src/features/navigator/pastePlacement';
import { defaultSlotInline, rootTag } from '../vendor/stacki/electron/parse/astroComponentApi';

test('real Lumos aliased tag defaults are recognized as text slots', async () => {
  for (const [component, tag] of [
    ['Heading', 'h2'],
    ['Paragraph', 'p'],
  ]) {
    const source = await readFile(`test/fixtures/site/src/components/typography/${component}.astro`, 'utf8');
    assert.equal(defaultSlotInline(source), true, component);
    assert.deepEqual(rootTag(source), { prop: 'tag', tag });
  }
  assert.equal(defaultSlotInline(await readFile('test/fixtures/site/src/components/wrapper/Section.astro', 'utf8')), false);
});

test('Stacki slot detection seeds text components and leaves structural wrappers empty', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-insert-defaults-'));
  const components = {
    Heading: '<h2><slot /></h2>',
    Paragraph: '<p><slot /></p>',
    Button: '<button><slot /></button>',
    Section: '<section><div><slot /></div></section>',
    ButtonWrapper: '<div><slot /></div>',
    Card: '---\nconst { heading = "Card heading" } = Astro.props;\n---\n<article><h2>{heading}</h2></article>',
  };
  try {
    await mkdir(path.join(root, 'src/components'), { recursive: true });
    await Promise.all(Object.entries(components).map(([name, source]) => writeFile(path.join(root, `src/components/${name}.astro`), source)));
    const project = await scanProject(root);
    for (const component of project.components) {
      const text = ['Heading', 'Paragraph', 'Button'].includes(component.name);
      assert.equal(component.slotText, text, component.name);
      const source = '<main></main>';
      const output = applyEdits(
        source,
        structuralEdits(source, {
          kind: 'insert',
          target: 'n0',
          name: component.name,
          importPath: '../components/' + component.name + '.astro',
          paired: component.slots.includes('default') && component.slotText,
        }),
      );
      assert.ok(output.includes(text ? `<${component.name}>Text</${component.name}>` : `<${component.name} />`));
      assert.ok(!output.includes('New content'));
    }
    const page = "---\nimport Wrapper from '../components/Section.astro';\n---\n<main><Wrapper /></main>";
    assert.equal(
      pastePlacement(page, 'src/pages/index.astro', 'n0.0', project.components),
      'inside',
      'An empty imported wrapper still accepts pasted children',
    );
    assert.equal(
      pastePlacement('<main><img /></main>', 'src/pages/index.astro', 'n0.0', project.components),
      'after',
      'Void elements cannot contain pasted children',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

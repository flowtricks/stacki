// Exercise the actual source edits and upstream placement rules used by the palette:
// every choice must round-trip, preserve existing source, and reject invalid input.
import assert from 'node:assert/strict';
import test from 'node:test';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, flatten, parseAction, parsePage } from '../src/features/source/source';
import { parseInsertContent } from '../src/features/source/insertContent';
import { insertTargetFor } from '../vendor/stacki/src/editor/insertTarget';
import { parsePageModel } from '../vendor/stacki/shared/page/pageNode';

const source = '---\n// Keep this comment.\nconst title = "Unchanged";\n---\n<section><h1>{title}</h1></section>\n';
test('component insertion reuses an existing alias import for the same resolved file', () => {
  const page = `---\nimport Section from '@/components/wrapper/Section.astro';\n---\n<Section></Section>`;
  const action = parseAction({
    kind: 'insert',
    target: 'layout',
    name: 'Section',
    importPath: '../../components/wrapper/Section.astro',
    paired: false,
  });
  const output = applyEdits(page, structuralEdits(page, action, 'src/pages/nested/page.astro'));
  assert.equal(output.match(/import Section/g)?.length, 1);
  assert.ok(!output.includes('SectionInserted'));
  assert.ok(output.includes('<Section />'));
  assert.ok(!output.includes('New content'));
});
const choices = [
  { type: 'element', tag: 'p' },
  { type: 'element', tag: 'input' },
  { type: 'element', tag: 'slot' },
  { type: 'astroAsset', name: 'Image' },
  { type: 'astroAsset', name: 'Picture' },
  ...['map', 'cond', 'text', 'comment', 'expr', 'doctype', 'style', 'script'].map((type) => ({
    type,
  })),
];
for (const choice of choices) {
  test(`palette inserts ${JSON.stringify(choice)} without rewriting existing source`, () => {
    const action = parseAction({
      kind: 'insert-content',
      target: 'n0',
      placement: 'inside',
      content: choice,
    });
    const result = applyEdits(source, structuralEdits(source, action));
    assert.ok(result.includes('// Keep this comment.\nconst title = "Unchanged";'));
    assert.ok(result.includes('<section><h1>{title}</h1>'));
    assert.ok(result.endsWith('</section>\n'));
    assert.ok(parsePage(result).editable, result);
    assert.notEqual(result, source);
  });
}
test('asset insertion reuses aliases and avoids project component collisions', () => {
  const action = parseAction({
    kind: 'insert-content',
    target: 'n0',
    placement: 'inside',
    content: { type: 'astroAsset', name: 'Image' },
  });
  const collision = source.replace('// Keep this comment.', "import Image from './Image.astro';");
  const result = applyEdits(collision, structuralEdits(collision, action));
  assert.ok(result.includes("import { Image as AstroImage } from 'astro:assets';"));
  assert.ok(result.includes('<AstroImage '));
  const alias = source.replace('// Keep this comment.', "import { Image as Photo } from 'astro:assets';");
  const reused = applyEdits(alias, structuralEdits(alias, action));
  assert.equal(reused.match(/astro:assets/g)?.length, 1);
  assert.ok(reused.includes('<Photo '));
});
test('empty pages accept new markup and asset imports', () => {
  for (const content of [
    { type: 'element', tag: 'div' },
    { type: 'astroAsset', name: 'Image' },
  ]) {
    const action = parseAction({ kind: 'insert-content', target: '', placement: 'after', content });
    const result = applyEdits('', structuralEdits('', action));
    assert.ok(parsePage(result).editable, result);
  }
});
test('invalid palette payloads cannot become arbitrary markup or imports', () => {
  for (const content of [null, { type: 'element', tag: 'div onclick="bad"' }, { type: 'astroAsset', name: 'Unknown' }, { type: 'invalid' }]) {
    assert.throws(() => parseInsertContent(content));
  }
  assert.throws(() =>
    parseAction({
      kind: 'insert-content',
      target: '',
      placement: 'invalid',
      content: { type: 'text' },
    }),
  );
});
test('Stacki placement inserts inside containers and alongside incompatible headings', () => {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  const model = parsePageModel(parsed.model);
  const heading = flatten(parsed.model.nodes).find((node) => node.name === 'h1');
  assert.ok(heading?.id);
  assert.deepEqual(insertTargetFor(model, 'n0', { type: 'element', tag: 'p' }, []), {
    parentId: 'n0',
    index: 1,
  });
  assert.deepEqual(insertTargetFor(model, heading.id, { type: 'element', tag: 'p' }, []), {
    parentId: 'n0',
    index: 1,
  });
  const componentPage = parsePage('<Heading tag="h1">Title</Heading>', { locs: true });
  assert.ok(componentPage.editable);
  const components = [{ name: 'Heading', slots: ['default'], renderTag: { prop: 'tag', tag: 'h2' } }];
  assert.deepEqual(insertTargetFor(parsePageModel(componentPage.model), 'n0', { type: 'element', tag: 'p' }, components), { parentId: undefined, index: 1 });
});

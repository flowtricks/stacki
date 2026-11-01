import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, flatten, nodesOf, parsePage } from '../src/features/source/source';
import { HEADING_TEXT, PARAGRAPH_TEXT } from '../src/features/source/instanceDefaults';

const files = {
  Heading: 'typography/Heading',
  Paragraph: 'typography/Paragraph',
  Button: 'Button',
  ButtonWrapper: 'wrapper/ButtonWrapper',
  ContentWrapper: 'wrapper/ContentWrapper',
  Grid: 'wrapper/Grid',
  Slider: 'interactive/Slider',
  Card: 'item/Card',
} as const;
const original = '---\r\n// Preserve this comment.\r\nconst untouched = 17;\r\n---\r\n<main><p>Keep existing content.</p></main>\r\n';
function insert(name: keyof typeof files, source = original) {
  const target = nodesOf(source)[0]?.id;
  assert.ok(target);
  return applyEdits(
    source,
    structuralEdits(
      source,
      {
        kind: 'insert',
        target,
        placement: 'inside',
        name,
        importPath: `@/components/${files[name]}.astro`,
        paired: false,
      },
      'src/pages/example.astro',
    ),
  );
}
test('insertion recipes initialize text and nested children without altering existing bytes', () => {
  for (const name of ['Heading', 'Paragraph', 'Button'] as const) {
    const source = insert(name);
    const node = flatten(nodesOf(source)).find((node) => node.name === name);
    assert.equal(node?.children?.[0]?.value, name === 'Heading' ? HEADING_TEXT : name === 'Paragraph' ? PARAGRAPH_TEXT : 'Button Text');
    assert.ok(source.includes('// Preserve this comment.\r\nconst untouched = 17;'));
    assert.ok(source.includes('<p>Keep existing content.</p>'));
  }
  const wrapper = flatten(nodesOf(insert('ButtonWrapper'))).find((node) => node.name === 'ButtonWrapper');
  assert.equal(wrapper?.children?.length, 1);
  assert.equal(wrapper?.children?.[0]?.name, 'Button');
  assert.equal(wrapper?.children?.[0]?.children?.[0]?.value, 'Button Text');
  const content = flatten(nodesOf(insert('ContentWrapper'))).find((node) => node.name === 'ContentWrapper');
  assert.deepEqual(
    content?.children?.map((node) => node.name),
    ['Heading', 'Paragraph', 'ButtonWrapper'],
  );
  assert.equal(content?.children?.[2]?.children?.[0]?.name, 'Button');
});
test('Grid, Slider and Card initialize their instance props and card content', () => {
  for (const name of ['Grid', 'Slider', 'Card'] as const) {
    const nodes = flatten(nodesOf(insert(name)));
    const node = nodes.find((node) => node.name === name);
    assert.ok(node);
    if (name !== 'Card') {
      assert.deepEqual(node.props?.['small'], {
        type: 'expr',
        value: name === 'Grid' ? '2' : '1.4',
      });
      if (name === 'Grid') {
        assert.deepEqual(node.props?.['medium'], { type: 'expr', value: '3' });
      }
      assert.equal(node.children?.length, name === 'Grid' ? 3 : 2);
    }
    const cards = nodes.filter((node) => node.name === 'Card');
    assert.equal(cards.length, name === 'Grid' ? 3 : name === 'Slider' ? 2 : 1);
    for (const card of cards) {
      assert.deepEqual(card.props?.['heading'], { type: 'string', value: HEADING_TEXT });
      assert.deepEqual(card.props?.['text'], { type: 'string', value: PARAGRAPH_TEXT });
    }
  }
});
test('nested recipes reuse aliased imports and avoid unrelated name collisions', () => {
  const source = '---\nimport MyButton from "@/components/Button.astro";\nimport Heading from "@/components/custom/Heading.astro";\n---\n<main />';
  const next = insert('ContentWrapper', source);
  const parsed = parsePage(next);
  assert.ok(parsed.editable);
  assert.equal(parsed.model.imports.filter((item) => item.path === '@/components/Button.astro').length, 1);
  const nodes = flatten(parsed.model.nodes);
  assert.equal(nodes.find((node) => node.name === 'MyButton')?.children?.[0]?.value, 'Button Text');
  assert.equal(nodes.find((node) => node.name === 'HeadingInserted')?.children?.[0]?.value, HEADING_TEXT);
  assert.ok(next.includes('import Heading from "@/components/custom/Heading.astro";'));
});

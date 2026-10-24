// Exercise edits against real Astro source and verify that unrelated bytes survive.
// Include malformed, stale, and unsafe targets so a failed edit cannot damage a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyEdits,
  nodeId,
  attributeEdit,
  contentEdit,
  flatten,
  nodesOf,
  structuralEdits,
  parsePage,
} from '../src/features/source/source';
import { filePath, sourcePath } from '../src/shared/validation';

const source = await readFile(new URL('./fixtures/homepage.astro', import.meta.url), 'utf8');
const nodes = flatten(nodesOf(source));
const heading = nodes.find((node) => node.name === 'Heading');
assert.ok(heading?.id);
const headingId = nodeId(heading);
test('content edit preserves the entire surrounding source', () => {
  const edit = contentEdit(source, headingId, 'Hello <world> {safe}');
  const next = applyEdits(source, [edit]);
  assert.equal(next.slice(0, edit.start), source.slice(0, edit.start));
  assert.ok(next.includes('Hello &lt;world> &#123;safe}'));
  assert.equal(next.slice(edit.start + edit.text.length), source.slice(edit.end));
  assert.ok(parsePage(next).editable);
});
test('attributes preserve frontmatter, whitespace, and other properties', () => {
  const edit = attributeEdit(source, headingId, 'class', 'a "quote" & more');
  const next = applyEdits(source, [edit]);
  assert.ok(next.includes('class="a &quot;quote&quot; &amp; more"'));
  assert.equal(next.replace(edit.text, source.slice(edit.start, edit.end)), source);
});
test('insert imports an existing component and remains parseable', () => {
  const edits = structuralEdits(source, {
    kind: 'insert',
    target: 'layout',
    name: 'Button',
    importPath: '@/components/Button.astro',
    paired: true,
  });
  const next = applyEdits(source, edits);
  assert.ok(next.includes('import Button from "@/components/Button.astro";'));
  assert.ok(next.includes('<Button>Button Text</Button>'));
  assert.ok(parsePage(next).editable);
});
test('a move cannot target its own descendant', () => {
  const section = nodes.find((node) => node.name === 'Section');
  assert.ok(section?.id);
  assert.throws(
    () =>
      structuralEdits(source, {
        kind: 'move',
        node: nodeId(section),
        target: headingId,
        placement: 'inside',
      }),
    /itself/,
  );
  assert.throws(() => structuralEdits(source, { kind: 'delete', node: 'layout' }), /layout/);
});
test('moving siblings keeps the source parseable and retains both', () => {
  const eyebrow = nodes.find((node) => node.name === 'Eyebrow');
  assert.ok(eyebrow?.id);
  const next = applyEdits(
    source,
    structuralEdits(source, {
      kind: 'move',
      node: headingId,
      target: nodeId(eyebrow),
      placement: 'after',
    }),
  );
  assert.ok(parsePage(next).editable);
  assert.ok(next.indexOf('<Heading') > next.indexOf('<Eyebrow'));
  assert.equal((next.match(/<Heading/g) ?? []).length, 1);
});
test('path guards reject traversal, hidden files and unsupported sources', () => {
  for (const input of [
    '../.env',
    'src/../.env',
    'src/.env',
    '/etc/passwd',
    'src/a\\b',
    'src/%2e%2e/a',
  ]) {
    assert.throws(() => filePath(input));
  }
  assert.throws(() => sourcePath('public/picture.png'));
  assert.equal(sourcePath('src/content/posts/hello.md'), 'src/content/posts/hello.md');
  assert.equal(sourcePath('src/pages/campus/[slug].astro'), 'src/pages/campus/[slug].astro');
  assert.equal(sourcePath('src/pages/[...path].astro'), 'src/pages/[...path].astro');
  assert.throws(() => sourcePath('src/pages/[slug]/../../.env'));
});

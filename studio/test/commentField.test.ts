// Goal: the Settings panel's Comment field edits the comment the Navigator shows as a
// node's label, by the rule the move planner carries it with: it adds one, rewords
// it, or clears it, and leaves every other comment alone. The demo shows each change
// without Astro, since a comment renders nothing.
// Method: a page written the way the marketing site writes its sections (a divider
// banner above each, inside a layout component) and a second with comments that
// label nothing. Each field write is applied to the source, the result reparsed and
// its labels read back, and the demo's page-change plan of each pair must refuse
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentEdits, commentFieldValue, labelOf } from '../src/features/settings/commentEdit';
import { applyEdits, parsePage, type ParserNode } from '../src/features/source/source';
import { planPageChange } from '../demo/pageChange';

const PAGE = `---
import Layout from "../layouts/Layout.astro";
import Section from "../components/Section.astro";
---
<Layout title="Home">
  {/* ------------------------------------ Hero */}
  <Section class="hero" />

  <Section id="features" />
  <!-- standalone -->
  Words
</Layout>
`;

function idOf(source: string, match: (node: ParserNode) => boolean): string {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  const pending = [...parsed.model.nodes];
  for (let index = 0; index < pending.length && index < 1000; index++) {
    const node = pending[index];
    assert.ok(node !== undefined);
    if (match(node)) {
      assert.ok(node.id !== undefined);
      return node.id;
    }
    pending.push(...(node.children ?? []));
  }
  throw new Error('No node matched');
}

function hasString(node: ParserNode, name: string, value: string): boolean {
  const attribute = node.props?.[name];
  return attribute?.type === 'string' && attribute.value === value;
}

const hero = (source: string) => idOf(source, (node) => hasString(node, 'class', 'hero'));
const features = (source: string) => idOf(source, (node) => hasString(node, 'id', 'features'));

function written(source: string, id: string, text: string): string {
  const next = applyEdits(source, commentEdits(source, id, text));
  assert.deepEqual(planPageChange(source, next).notShown, [], 'the demo shows a comment change without Astro');
  return next;
}

test('the field reads the label without its divider rule, and nothing for an unlabelled node', () => {
  assert.equal(commentFieldValue(PAGE, hero(PAGE)), 'Hero');
  assert.equal(commentFieldValue(PAGE, features(PAGE)), '');
});

test('rewording keeps the label’s syntax and its rule', () => {
  const next = written(PAGE, hero(PAGE), 'Welcome');
  assert.match(next, /\n {2}\{\/\* -{3,} Welcome \*\/\}\n {2}<Section class="hero" \/>/);
  const width = (source: string) => /\{\/\*.*\*\/\}/.exec(source)?.[0].length;
  assert.equal(width(next), width(PAGE), 'a divider keeps its width, so a column of them stays lined up');
  assert.equal(commentFieldValue(next, hero(next)), 'Welcome');
});

test('adding writes a comment on the line above the node, which then labels it', () => {
  const next = written(PAGE, features(PAGE), 'What you can do');
  assert.ok(next.includes('\n\n  <!-- What you can do -->\n  <Section id="features" />'));
  assert.equal(commentFieldValue(next, features(next)), 'What you can do');
  assert.equal(labelOf(next, features(next)).label?.kind, 'comment');
});

test('clearing removes the label and leaves no blank row behind', () => {
  const next = written(PAGE, hero(PAGE), '   ');
  assert.equal(next.includes('Hero'), false);
  assert.ok(next.includes('<Layout title="Home">\n  <Section class="hero" />'));
  assert.equal(commentFieldValue(next, hero(next)), '');
  assert.deepEqual(commentEdits(next, features(next), ''), [], 'clearing an absent label writes nothing');
});

test('a comment that labels nothing is never the field’s', () => {
  const words = idOf(PAGE, (node) => node.kind === 'text' && (node.value ?? '').includes('Words'));
  assert.equal(labelOf(PAGE, words).label, undefined, 'a comment above text is no label');
  assert.throws(() => commentEdits(PAGE, words, 'x'), /Only an element or a component takes a comment/);
  const next = written(PAGE, features(PAGE), 'Features');
  assert.ok(next.includes('<!-- standalone -->'), 'the standalone comment stays');
});

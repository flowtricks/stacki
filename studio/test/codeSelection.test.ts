import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../src/features/source/source';
import { parsePageModel } from '../vendor/stacki/shared/page/pageNode';
import { sourceRangeForSelection, sourceNodeAtOffset } from '../vendor/stacki/src/features/code/codePanelModel';

const source = '---\r\nconst title = "🌱";\r\n---\r\n<main>\r\n  <Heading tag="h1">Hello 🌱</Heading>\r\n</main>\r\n';

test('located Studio models retain exact code ranges, including CRLF and Unicode', () => {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  const model = parsePageModel(parsed.model);
  const offset = source.indexOf('Hello');
  const heading = sourceNodeAtOffset(model.nodes, offset);
  assert.ok(heading);
  assert.equal(heading.name, 'Heading');
  const range = sourceRangeForSelection(model, heading.id, source.length);
  assert.ok(range);
  assert.equal(source.slice(range.from, range.to), '<Heading tag="h1">Hello 🌱</Heading>');
  const frontmatter = sourceRangeForSelection(model, 'frontmatter', source.length);
  assert.ok(frontmatter);
  assert.equal(frontmatter.from, 0);
  assert.ok(source.slice(frontmatter.from, frontmatter.to).includes('const title'));
  assert.ok(!source.slice(frontmatter.from, frontmatter.to).includes('<main>'));
  assert.equal(sourceRangeForSelection(model, 'missing', source.length), undefined);
  assert.equal(sourceRangeForSelection(model, heading.id, range.from), undefined);
});

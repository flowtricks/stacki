// Goal: Studio writes a loop's Filters, Sort and Limit as Desktop does, through
// the same plan (loopQueryPlan.ts), onto the page's own bytes. The stacki.build
// home page's loop over a written-out list is the case: its settings go into the
// loop's head, and nothing else on the page moves.
//
// Method: the page's frontmatter and loop, as written, go through loopSourceEdit
// with the targets the shared LoopSettings hands back (a query over the item
// itself, a section typed as code, a clear back to nothing), and the page that
// comes out is compared byte for byte with the page expected, then parsed again
// to read the same settings back. A refused plan returns the page untouched with
// its reason. Last, the demo's loop order (demo/loopOrder.ts) runs the written
// head on the array and must pick the items the written code would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopSourceEdit } from '../src/features/settings/loopSourceEdit';
import { flatten, nodesOf } from '../src/features/source/source';
import { emptyQuery, ITEM_FIELD, type LoopQuery } from '../vendor/stacki/src/editor/loopQuery';
import { loopRun } from '../demo/loopOrder';
import { readLoop } from '../vendor/stacki/src/editor/loopQueryRead';
import { writtenListFields } from '../vendor/stacki/src/editor/loopLiteral';

const PAGE = `---
import Icon from "@/components/Icon.astro";

const promises = [
  "Free and open source",
  "Works on any Astro site",
  "Easy to customize",
];
---
<ul class="promises">
  {promises.map((promise) => (
    <li class="promises_item">
      <Icon variant="small" />
      {promise}
    </li>
  ))}
</ul>
`;

function loopId(source: string): string {
  const loop = flatten(nodesOf(source)).find((node) => node.kind === 'map');
  assert.ok(loop?.id);
  return loop.id;
}

const empty = emptyQuery({ kind: 'list', collection: 'promises' });

test('a filter, a sort and a limit are written into the loop’s head and read back', () => {
  const query: LoopQuery = {
    ...empty,
    conditions: [{ kind: 'custom', code: 'item !== "Easy to customize"' }],
    customSort: '(a, b) => b.localeCompare(a)',
    limit: 2,
  };
  const edited = loopSourceEdit(PAGE, loopId(PAGE), { kind: 'query', query, fields: [] }, 'unavailable');
  assert.deepEqual(edited.result, { ok: true, unbound: 0, lost: [], restored: false });
  const data = 'promises.filter((item) => item !== "Easy to customize").toSorted((a, b) => b.localeCompare(a)).slice(0, 2)';
  assert.equal(edited.source, PAGE.replace('{promises.map(', `{${data}.map(`));
  const frontmatter = 'const promises = [\n  "Free and open source",\n  "Works on any Astro site",\n  "Easy to customize",\n];';
  // Hand-written code over the item itself reads back as the settings that say it.
  const { customSort: _custom, ...settings } = query;
  assert.deepEqual(readLoop({ frontmatter, imports: [], data }), {
    kind: 'query',
    query: {
      ...settings,
      conditions: [{ kind: 'test', field: ITEM_FIELD, operator: 'isNot', value: { kind: 'text', text: 'Easy to customize' } }],
      sorts: [{ field: ITEM_FIELD, direction: 'descending', order: 'text' }],
    },
    chain: ['promises'],
    client: undefined,
  });
  const cleared = loopSourceEdit(edited.source, loopId(edited.source), { kind: 'query', query: empty, fields: [] }, 'unavailable');
  assert.equal(cleared.source, PAGE, 'clearing every setting gives the page back as it was');
});

test('a limit typed as code is written where the limit goes', () => {
  const edited = loopSourceEdit(PAGE, loopId(PAGE), { kind: 'section', section: 'limit', code: '1' }, 'unavailable');
  assert.equal(edited.result.ok, true);
  assert.equal(edited.source, PAGE.replace('{promises.map(', '{promises.slice(0, 1).map('));
});

test('a written-out list of plain values is its own field', () => {
  assert.deepEqual(writtenListFields('const promises = ["a", "b"];', 'promises'), [{ path: ITEM_FIELD, kind: 'text' }]);
  assert.deepEqual(writtenListFields('const sizes = [1, 2];', 'sizes'), [{ path: ITEM_FIELD, kind: 'number' }]);
  assert.deepEqual(writtenListFields('const plans = [{ title: "Pro", price: 9 }];', 'plans'), [
    { path: 'title', kind: 'text' },
    { path: 'price', kind: 'number' },
  ]);
});

test('a refused plan leaves the page as it was and says why', () => {
  const edited = loopSourceEdit(PAGE, loopId(PAGE), { kind: 'section', section: 'limit', code: 'nope(' }, 'unavailable');
  assert.equal(edited.result.ok, false);
  assert.equal(edited.source, PAGE);
});

test('a loop that is not on the page throws, as every Studio edit does', () => {
  assert.throws(() => loopSourceEdit(PAGE, 'missing', { kind: 'empty' }, 'unavailable'), /Select the loop again/);
});

test('a new source re-points the children inside the loop, as Desktop’s plan does', () => {
  const page = '---\nconst posts = [{ title: "a" }];\n---\n<ul>\n  {posts.map((post) => (\n    <li>{post.title}</li>\n  ))}\n</ul>\n';
  const query = emptyQuery({ kind: 'astro', collection: 'blog' });
  const fields = [{ path: 'title', title: 'Title', kind: 'text' as const, options: [] }];
  const edited = loopSourceEdit(page, loopId(page), { kind: 'query', query, fields }, 'unavailable');
  assert.equal(edited.result.ok, true);
  assert.match(edited.source, /^---\nimport \{ getCollection \} from 'astro:content';\n/);
  assert.match(edited.source, /const blogEntries = await getCollection\('blog'\);/);
  assert.match(edited.source, /blogEntries\.map\(\(post\) => \(\n\s+<li>\{post\.data\.title\}<\/li>/);
  assert.ok(edited.source.endsWith('</ul>\n'), 'the markup after the loop is kept');
});

test('a filter, sort and limit on the item itself are written as the loop names it', () => {
  const query: LoopQuery = {
    ...empty,
    conditions: [{ kind: 'test', field: ITEM_FIELD, operator: 'contains', value: 'o' }],
    sorts: [{ field: ITEM_FIELD, direction: 'descending', order: 'text' }],
    limit: 2,
  };
  const edited = loopSourceEdit(PAGE, loopId(PAGE), { kind: 'query', query, fields: [] }, 'unavailable');
  assert.equal(edited.result.ok, true);
  const data =
    "promises.filter((promise) => String(promise ?? '').toLowerCase().includes('o')).toSorted((a, b) => String(b ?? '').localeCompare(String(a ?? ''))).slice(0, 2)";
  assert.equal(edited.source, PAGE.replace('{promises.map(', `{${data}.map(`));
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(edited.source)?.[1] ?? '';
  const reading = readLoop({ frontmatter, imports: [], data, fieldKind: () => 'text' });
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.kind === 'query' ? reading.query : undefined, { ...query, parameter: { kind: 'entry', name: 'promise' } });
  // The demo shows the baked copies the written code keeps: every promise holds an
  // "o", reverse alphabetical, the first two.
  const run = loopRun(frontmatter, `${data}.map((promise) => (`);
  assert.deepEqual(run?.order, [1, 0], 'Works on any Astro site, then Free and open source');
});

test('the demo compares numbers in a list of numbers', () => {
  const frontmatter = 'const sizes = [3, 12, 7];';
  const run = loopRun(frontmatter, 'sizes.filter((size) => size > 5).toSorted((a, b) => (a ?? 0) - (b ?? 0)).map((size) => (');
  assert.deepEqual(run?.order, [2, 1]);
});

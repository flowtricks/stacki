// Goal: a pick from Studio's binding picker that names data the page does not
// read yet writes the same frontmatter Desktop writes (vendor
// src/editor/frontmatterAdditions.ts): a data file export's import, joined to
// the module's existing import, aliased when its name is taken, and a project
// collection's `getCollection` query. Everything below the frontmatter stays
// byte for byte.
//
// Method: a page with an import and markup goes through dataImportEdit and
// collectionQueryEdit, and the source that comes out is compared with the page
// expected; the name each answers is the name the binding then reads. An edit
// already made answers the page untouched, and a page that does not parse is
// refused with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionQueryEdit, dataImportEdit } from '../src/features/settings/frontmatterAdditionEdit';

const PAGE = `---
import { NAV } from "@/consts";
import Layout from "../layouts/Layout.astro";

const title = "Home";
---
<Layout title={title}>
  <h1>Hello</h1>
</Layout>
`;
const BODY = PAGE.slice(PAGE.indexOf('---\n<Layout'));

test('a data file export joins the module’s import, and the markup does not move', () => {
  const added = dataImportEdit(PAGE, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(added.name, 'SITE');
  assert.ok(added.source.startsWith('---\nimport { NAV, SITE } from "@/consts";\nimport Layout from "../layouts/Layout.astro";\n\nconst title = "Home";\n'));
  assert.ok(added.source.endsWith(BODY), 'everything after the frontmatter is as it was');
  const again = dataImportEdit(added.source, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(again.source, added.source, 'an import already there writes nothing');
  assert.equal(again.name, 'SITE');
});

test('an export whose name the page already uses is imported under an alias', () => {
  const taken = PAGE.replace('const title = "Home";', 'const SITE = "mine";');
  const added = dataImportEdit(taken, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(added.name, 'SITE2');
  assert.match(added.source, /import \{ NAV, SITE as SITE2 \} from "@\/consts";/);
});

test('a collection is read through one marked query', () => {
  const added = collectionQueryEdit(PAGE, 'stats');
  assert.equal(added.name, 'statsEntries');
  assert.match(added.source, /import \{ getCollection \} from 'astro:content';/);
  assert.match(added.source, /const statsEntries = await getCollection\('stats'\); \/\/ stacki:query\n---\n/);
  assert.ok(added.source.endsWith(BODY));
  assert.equal(collectionQueryEdit(added.source, 'stats').source, added.source, 'the same collection is the same query');
});

test('a page that does not parse is refused with its reason', () => {
  assert.throws(() => dataImportEdit('---\nconst a = {\n---\n<div>', { spec: '@/consts', exported: 'SITE', name: 'SITE' }), /Fix the page syntax/);
});

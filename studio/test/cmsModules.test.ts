import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmsFixture } from './cmsFixture';
import { record } from '../src/shared/validation';
import { parseCmsFiles } from '../vendor/stacki/src/features/cms/cmsPanelBridge';
import { collectionOf, collectionHasContent } from '../vendor/stacki/src/features/cms/cmsSchema';

test('CMS discovers general-only modules throughout src and preserves unrelated TypeScript', async () => {
  const source = [
    '/** Site name. Keep this comment. */',
    'export const SITE_NAME: string = "Original";',
    'export const SITE_DESCRIPTION = "Description";',
    'export const NOINDEX_ROUTES: string[] = ["/404"];',
    'const privateSetting = "Private";',
    '',
  ].join('\r\n');
  const fixture = await cmsFixture({
    'src/consts.ts': source,
    'src/config/site.ts': 'export const site = { title: "Nested settings" };',
    'src/config/site.mts': 'export const title = "Module settings";',
    'src/config/site.cts': 'export const title = "Common settings";',
    'src/config/site.js': 'export const title = "JavaScript settings";',
    'src/data/settings.ts': 'export const title = "Data settings";',
    'src/config/items.ts': 'export const items = [{ title: "An item" }];',
    'src/pages/robots.txt.ts': 'export const GET = () => new Response("robots");',
    'src/types.d.ts': 'export const title: "A declaration";',
  });
  try {
    const listing = parseCmsFiles((await fixture.post('cms:list', 'studio'))['value']);
    const visible = listing.filter((file) => collectionHasContent(collectionOf(file)));
    assert.deepEqual(
      visible.map((file) => file.rel).sort(),
      [
        'consts.ts#*general',
        'config/site.ts#*general',
        'config/site.mts#*general',
        'config/site.cts#*general',
        'config/site.js#*general',
        'data/settings.ts#*general',
        'config/items.ts#items',
      ].sort(),
    );
    const payload = { projectPath: 'studio', rel: 'consts.ts#*general' };
    const before = await fixture.post('cms:read', payload);
    const data = record(record(before['value'])['data']);
    assert.equal(data['SITE_NAME'], 'Original');
    assert.equal(data['privateSetting'], undefined);
    const saved = await fixture.post('cms:write', { ...payload, data: { ...data, SITE_NAME: 'Updated' } }, before['versions']);
    assert.equal(saved['error'], undefined);
    assert.equal(record(saved['value'])['ok'], true);
    assert.equal(await fixture.rooms.read('src/consts.ts'), source.replace('Original', 'Updated'));
  } finally {
    await fixture.close();
  }
});

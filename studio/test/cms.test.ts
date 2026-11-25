// Exercise the actual Stacki handlers through HTTP and shared rooms. Round trips
// must preserve untouched source, reject stale revisions, and retain schema data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cmsFixture } from './cmsFixture';
import { record } from '../src/shared/validation';
import { parseCmsFiles } from '../vendor/stacki/src/features/cms/cmsPanelBridge';
import { parseContentEntries } from '../vendor/stacki/src/features/content/contentViewBridge';

const page = 'src/pages/index.astro';
const original = '---\r\n// Keep this comment.\r\nconst title = "Welcome";\r\nconst items = [{ name: "First", count: 2 }];\r\n---\r\n<h1>{title}</h1>\r\n';
const payload = { projectPath: 'studio', rel: 'pages/index.astro#items' };
test('CMS discovers page data and patches only its declaration; stale saves and undo are rejected', async () => {
  const fixture = await cmsFixture({ [page]: original });
  try {
    const listing = parseCmsFiles((await fixture.post('cms:list', 'studio'))['value']);
    assert.ok(listing.some((item) => item.rel === payload.rel));
    const before = await fixture.post('cms:read', payload);
    const data = [{ name: 'Updated', count: 3 }];
    assert.equal(record((await fixture.post('cms:write', { ...payload, data }, before['versions']))['value'])['ok'], true);
    const saved = await readFile(path.join(fixture.root, page), 'utf8');
    assert.ok(saved.startsWith(original.slice(0, original.indexOf('[{'))));
    assert.ok(saved.endsWith(original.slice(original.indexOf('];') + 1)));
    const stale = await fixture.post('cms:write', { ...payload, data: [] }, before['versions']);
    assert.match(String(stale['error']), /changed/);
    const current = await fixture.post('cms:read', payload);
    const undo = await fixture.post('cms:write', { ...payload, data: [] }, current['versions'], [{ name: 'Another editor' }]);
    assert.match(String(undo['error']), /newer content/);
    assert.equal(await readFile(path.join(fixture.root, page), 'utf8'), saved);
    for (const rel of ['../package.json', '/tmp/outside.json', 'data/../../package.json']) {
      assert.ok((await fixture.post('cms:read', { ...payload, rel }))['error']);
    }
  } finally {
    await fixture.close();
  }
});
test('CMS creates collections, persists field types, deletes collections and repairs imports', async () => {
  const fixture = await cmsFixture({
    [page]: '---\nimport items from "../data/items.json";\n---\n{items.map(x => <p>{x.title}</p>)}',
    'src/data/items.json': '[{"title":"One"}]\n',
  });
  try {
    const created = await fixture.post('cms:create', {
      projectPath: 'studio',
      name: 'Testimonials',
    });
    assert.equal(record(created['value'])['rel'], 'data/testimonials.json');
    assert.equal(await fixture.rooms.read('src/data/testimonials.json'), '[]\n');
    const meta = await fixture.post('cms:meta', 'studio');
    const declared = { title: 'longtext' };
    assert.ok((await fixture.post('cms:setMeta', { projectPath: 'studio', rel: 'data/items.json', fields: declared }, meta['versions']))['value']);
    assert.deepEqual(record(record((await fixture.post('cms:meta', 'studio'))['value'])['meta'])['data/items.json'], declared);
    const target = { projectPath: 'studio', rel: 'data/items.json' };
    const usage = await fixture.post('cms:usage', target);
    assert.deepEqual(record(usage['value'])['files'], ['pages/index.astro']);
    assert.ok((await fixture.post('cms:delete', target, usage['versions']))['value']);
    assert.match(await fixture.rooms.read(page), /const items = \[\]/);
    assert.ok(!parseCmsFiles((await fixture.post('cms:list', 'studio'))['value']).some((file) => file.rel.includes('studio-cms-schema')));
  } finally {
    await fixture.close();
  }
});
test('Astro glob collections expose schema fields and preserve Markdown body on field edits', async () => {
  const file = 'src/content/posts/hello.md';
  const source = '---\ntitle: Hello # keep\n---\n\nBody stays here.\n';
  const fixture = await cmsFixture({
    'src/content.config.ts':
      "import { defineCollection, z } from 'astro:content'; import { glob } from 'astro/loaders'; export const collections = { posts: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/posts' }), schema: z.object({ title: z.string() }) }) };",
    [file]: source,
  });
  try {
    const response = await fixture.post('content:entries', {
      projectPath: 'studio',
      name: 'posts',
    });
    assert.equal(response['error'], undefined);
    const entries = parseContentEntries(response['value']);
    assert.equal(entries.entries[0]?.id, 'hello');
    assert.ok(entries.collection.schema);
    const write = await fixture.post(
      'content:writeEntry',
      {
        projectPath: 'studio',
        entry: { file, locator: [] },
        edits: [{ path: ['title'], value: 'Changed' }],
      },
      response['versions'],
    );
    assert.equal(write['error'], undefined);
    assert.equal(await fixture.rooms.read(file), source.replace('Hello', 'Changed'));
    const invalid = await fixture.post('content:writeEntry', {
      projectPath: 'studio',
      entry: { file: '../escape.md', locator: [] },
      edits: [],
    });
    assert.ok(invalid['error']);
  } finally {
    await fixture.close();
  }
});

test('content edits reject stale entry data even after a background refresh, and renames persist through restart', async () => {
  const file = 'src/content/posts/hello.md';
  const fixture = await cmsFixture({
    'src/content.config.ts':
      "import { defineCollection, z } from 'astro:content'; import { glob } from 'astro/loaders'; export const collections = { posts: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/posts' }), schema: z.object({ title: z.string() }) }) };",
    [file]: '---\ntitle: Hello\n---\nBody\n',
  });
  try {
    const target = { projectPath: 'studio', name: 'posts' };
    const before = await fixture.post('content:entries', target);
    const write = {
      projectPath: 'studio',
      entry: { file, locator: [] },
      edits: [{ path: ['title'], value: 'Collaborator' }],
    };
    assert.ok((await fixture.post('content:writeEntry', write, before['versions']))['value']);
    const fresh = await fixture.post('content:entries', target);
    const rejected = await fixture.post('content:writeEntry', { ...write, edits: [{ path: ['title'], value: 'Stale' }] }, fresh['versions'], {
      data: { title: 'Hello' },
      body: 'Body\n',
    });
    assert.match(String(rejected['error']), /collaborator changed/);
    const plan = await fixture.post('content:renamePlan', {
      ...target,
      from: 'hello',
      to: 'greeting',
    });
    const renamed = await fixture.post('content:rename', { ...target, from: 'hello', to: 'greeting' }, plan['versions']);
    assert.ok(renamed['value'], JSON.stringify(renamed));
    const inventory = JSON.parse(await fixture.rooms.read('src/data/studio-cms-deleted.json')) as unknown;
    assert.deepEqual(inventory, [file]);
    assert.match(await fixture.rooms.read('src/content/posts/greeting.md'), /Collaborator/);
    const { writeFile } = await import('node:fs/promises');
    const { restoreCmsDeletions } = await import('../src/features/cms/cmsDeleted');
    await writeFile(path.join(fixture.root, file), 'Repository baseline restored during startup');
    await restoreCmsDeletions(fixture.root);
    await assert.rejects(readFile(path.join(fixture.root, file)), /ENOENT/);
  } finally {
    await fixture.close();
  }
});

// Goal: what the CMS panel does with Payload content is right, and never harms the live site: a list is
// read in pages and capped, every write is a draft (`draft=true` on every PATCH: without it Payload
// publishes), a collection without drafts says its edits are live, publish/unpublish/discard/restore do what
// their names say, and what Stacki cannot rebuild exactly (formatted rich text, an oversized value) is shown
// but never written.
// Method: the fake Payload (test/helpers/fakePayload.js, replies recorded from a real Payload 3.93) behind the
// real provider code; assertions on the replies AND on the exact requests the server received. The same
// flows were run against a real server (docs/cms-testing.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePayload, API_KEY } = require('../../helpers/fakePayload.js');
const { payloadRemoteService } = require('#dist/electron/content/payloadService.js');
const { clearPayloadSessions } = require('#dist/electron/content/payloadClient.js');
const { clearPayloadSchemas } = require('#dist/electron/content/payloadSchema.js');
const cms = require('#dist/shared/properties/cmsRemote.js');

const target = (base) => ({ baseUrl: base, collection: 'users', auth: { kind: 'apiKey', key: API_KEY } });
const through = (value) => JSON.parse(JSON.stringify(value));
const field = (document, name) => document.fields.find((candidate) => candidate.name === name);
const failure = async (run) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};
async function withFake(options, run) {
  clearPayloadSessions();
  clearPayloadSchemas();
  const fake = await fakePayload(options);
  try {
    await run(fake, payloadRemoteService(target(fake.base), { named: [] }));
  } finally {
    await fake.close();
  }
}

test('collections: what the server lists, without Payload’s own bookkeeping, and the renderer accepts it', async () => {
  await withFake({}, async (fake, service) => {
    const collections = await service.collections();
    assert.deepEqual(collections.map((collection) => collection.name).sort(), ['categories', 'media', 'pages', 'posts', 'users']);
    cms.parseRemoteCollections(through(collections));
  });
});

test('a list is read in pages of 100, never limit=0, and stops at 500', async () => {
  await withFake({ postCount: 650 }, async (fake, service) => {
    const list = await service.documents('posts', ['views']);
    assert.equal(list.documents.length, 500);
    assert.equal(new Set(list.documents.map((item) => item.id)).size, 500, 'no document twice across pages');
    const listCalls = fake.calls.filter((call) => call.path === '/api/posts' && call.method === 'GET' && call.query.sort === '-updatedAt');
    assert.deepEqual(
      listCalls.map((call) => call.query.page),
      ['1', '2', '3', '4', '5'],
    );
    assert.ok(listCalls.every((call) => call.query.limit === '100' && call.query.depth === '0'));
    assert.ok(fake.calls.every((call) => call.query.limit !== '0'));
    cms.parseRemoteDocumentList(through(list));
    assert.equal(list.documents[0].cells.views, 650, 'newest first, with the requested column');
  });
});

test('a short list is one request, and its status says draft, published or changed', async () => {
  await withFake({ postCount: 5 }, async (fake, service) => {
    await service.write({ id: 'posts.1', field: 'views', value: 77 });
    const list = await service.documents('posts');
    const byId = Object.fromEntries(list.documents.map((item) => [item.id, item.status]));
    assert.equal(byId['posts.1'], 'changed', 'a draft over a published document');
    assert.equal(byId['posts.2'], 'published');
    assert.equal(byId['posts.5'], 'draft', 'never published');
  });
});

test('a collection that does not exist, or cannot be read, is not found, not a crash', async () => {
  await withFake({}, async (fake, service) => {
    assert.equal((await failure(() => service.documents('nothing')))?.failure, 'notFound');
    assert.equal((await failure(() => service.document('posts.9999')))?.failure, 'notFound');
    assert.equal((await failure(() => service.document('garbage')))?.failure, 'notFound');
  });
});

test('a document reads as the panel’s own field types, and the renderer’s parser accepts it', async () => {
  await withFake({}, async (fake, service) => {
    const document = await service.document('posts.1');
    cms.parseRemoteDocument(through(document));
    assert.equal(document.type, 'posts');
    assert.equal(document.status, 'published');
    assert.equal(field(document, 'title').type.kind, 'object', 'a localized field is one entry per locale');
    assert.deepEqual(field(document, 'title').value, { en: 'Post 1' });
    assert.equal(field(document, 'body').value, 'Body of post 1', 'rich text is its text');
    assert.notEqual(field(document, 'body').readOnly, 'always');
    assert.equal(field(document, 'views').type.kind, 'number');
    assert.deepEqual(
      field(document, 'kind').type.options.map((option) => option.value),
      ['news', 'guide'],
      'select options come from GraphQL',
    );
    assert.equal(field(document, 'cover').type.kind, 'image');
    assert.equal(field(document, 'author').type.kind, 'reference');
    assert.match(document.editURL, /\/admin\/collections\/posts\/1$/);
    const names = document.fields.map((item) => item.name);
    for (const hidden of ['id', 'createdAt', 'updatedAt', '_status', 'apiKey', 'hash', 'salt', 'sessions']) {
      assert.ok(!names.includes(hidden), `${hidden} is not a field`);
    }
  });
});

test('a user document never shows a key, a hash or a session', async () => {
  await withFake({}, async (fake, service) => {
    const template = await service.template('users');
    const names = template.fields.map((item) => item.name);
    assert.ok(!names.some((name) => /apiKey|hash|salt|sessions|password|loginAttempts|lockUntil/.test(name)), names.join(','));
  });
});

test('a write saves a DRAFT: the live document is untouched and every PATCH says draft=true', async () => {
  await withFake({}, async (fake, service) => {
    const before = fake.posts.get(2).views;
    const document = await service.write({ id: 'posts.2', field: 'views', value: 4242 });
    assert.equal(fake.posts.get(2).views, before, 'the live document did not change');
    assert.equal(field(document, 'views').value, 4242, 'the panel shows the draft');
    assert.equal(document.status, 'changed');
    const patches = fake.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].query.draft, 'true');
    assert.deepEqual(patches[0].body, { views: 4242 }, 'one field, nothing else');
    assert.equal(patches[0].body._status, undefined, 'a write never touches the status');
  });
});

test('writing every kind of value lands in the draft in Payload’s own shape', async () => {
  await withFake({}, async (fake, service) => {
    const write = (name, value) => service.write({ id: 'posts.2', field: name, value });
    await write('contact', 'x@example.test');
    await write('tags', ['y']);
    await write('where', { _type: 'geopoint', lat: 1.5, lng: 2.5 });
    await write('extra', '{"a":1}');
    await write('meta', { description: 'hello' });
    await write('categories', [{ _key: 'a', _type: 'reference', _ref: 'categories.2' }]);
    await write('cover', { _type: 'image', asset: { _type: 'reference', _ref: 'image-media-3' } });
    await write('links', [{ _key: 'fresh', _type: 'links', label: 'L', url: 'https://x.test' }]);
    await write('body', 'First\nSecond');
    const bodies = fake.calls.filter((call) => call.method === 'PATCH').map((call) => call.body);
    assert.deepEqual(bodies[0], { contact: 'x@example.test' });
    assert.deepEqual(bodies[1], { tags: ['y'] });
    assert.deepEqual(bodies[2], { where: [2.5, 1.5] }, 'a point is [longitude, latitude]');
    assert.deepEqual(bodies[3], { extra: { a: 1 } }, 'JSON text is parsed');
    assert.deepEqual(bodies[4], { meta: { description: 'hello' } });
    assert.deepEqual(bodies[5], { categories: [2] }, 'a relationship is its id');
    assert.deepEqual(bodies[6], { cover: 3 }, 'an upload is the media id');
    assert.deepEqual(bodies[7], { links: [{ label: 'L', url: 'https://x.test' }] }, 'a made-up row key is not sent as an id');
    assert.deepEqual(
      bodies[8].body.root.children.map((paragraph) => paragraph.children[0].text),
      ['First', 'Second'],
    );
    assert.ok(fake.calls.filter((call) => call.method === 'PATCH').every((call) => call.query.draft === 'true'));
  });
});

test('a localized field is written one locale at a time, and only the locales that changed', async () => {
  await withFake({}, async (fake, service) => {
    const document = await service.document('posts.1');
    await service.write({ id: 'posts.1', field: 'title', value: { ...field(document, 'title').value, fr: 'Titre' } });
    const patches = fake.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1, 'English was unchanged and is not written');
    assert.equal(patches[0].query.locale, 'fr');
    assert.deepEqual(patches[0].body, { title: 'Titre' });
    assert.equal(patches[0].query.draft, 'true');
    fake.calls.length = 0;
    const current = await service.document('posts.1');
    await service.write({ id: 'posts.1', field: 'title', value: field(current, 'title').value });
    assert.equal(fake.calls.filter((call) => call.method === 'PATCH').length, 0, 'an edit that changes nothing writes nothing');
  });
});

test('a write the server refuses is reported with the field it names, and nothing else is written', async () => {
  await withFake({}, async (fake, service) => {
    const error = await failure(() => service.write({ id: 'pages.1', field: 'name', value: undefined }));
    assert.equal(error.failure, 'invalid');
    assert.match(error.message, /Name: This field is required/);
    assert.equal(fake.pages.get(1).name, 'Home');
    const unknown = await failure(() => service.write({ id: 'posts.1', field: 'nope', value: 'x' }));
    assert.equal(unknown.failure, 'invalid');
    const badJson = await failure(() => service.write({ id: 'posts.1', field: 'extra', value: '{oops' }));
    assert.match(badJson.message, /not valid JSON/);
    assert.equal(fake.calls.filter((call) => call.method === 'PATCH').length, 1, 'only the pages attempt reached the server');
  });
});

test('a collection without drafts says its edits are live, and they are', async () => {
  await withFake({}, async (fake, service) => {
    const before = await service.document('pages.1');
    assert.equal(before.appliesLive, true);
    const template = await service.template('pages');
    assert.equal(template.appliesLive, true);
    const posts = await service.document('posts.1');
    assert.equal(posts.appliesLive, undefined, 'a collection with drafts does not');
    const after = await service.write({ id: 'pages.1', field: 'blurb', value: 'Changed' });
    assert.equal(fake.pages.get(1).blurb, 'Changed', 'the live page changed');
    assert.equal(after.appliesLive, true);
    assert.equal(cms.parseRemoteDocument(through(after)).appliesLive, true);
    assert.equal((await failure(() => service.act('pages.1', 'publish')))?.failure, 'invalid', 'no drafts to publish');
    assert.deepEqual(await service.history('pages.1'), []);
  });
});

test('rich text with formatting is shown, read-only, and a write to it is refused', async () => {
  await withFake({}, async (fake, service) => {
    const formatted = structuredClone(fake.posts.get(1).body);
    formatted.root.children[0].children[0].format = 1;
    fake.posts.get(1).body = formatted;
    fake.versions.find((version) => version.parent === 1).version.body = formatted;
    const document = await service.document('posts.1');
    assert.equal(field(document, 'body').readOnly, 'always');
    assert.equal(field(document, 'body').value, 'Body of post 1');
    const error = await failure(() => service.write({ id: 'posts.1', field: 'body', value: 'overwrite' }));
    assert.equal(error.failure, 'invalid');
    assert.match(error.message, /Edit it in Payload/);
    assert.equal(fake.calls.filter((call) => call.method === 'PATCH').length, 0);
  });
});

test('a value too large for the panel is shown cut and read-only, never written back cut', async () => {
  await withFake({}, async (fake, service) => {
    fake.posts.get(1).snippet = 'x'.repeat(400_000);
    fake.versions.find((version) => version.parent === 1).version.snippet = 'x'.repeat(400_000);
    const document = await service.document('posts.1');
    const snippet = field(document, 'snippet');
    assert.equal(snippet.readOnly, 'always');
    assert.ok(snippet.value.length < 100_000);
    cms.parseRemoteDocument(through(document));
  });
});

test('publish applies the draft, unpublish takes it off, discard puts the published version back', async () => {
  await withFake({}, async (fake, service) => {
    await service.write({ id: 'posts.2', field: 'views', value: 999 });
    const published = await service.act('posts.2', 'publish');
    assert.equal(published.status, 'published');
    assert.equal(fake.posts.get(2).views, 999);
    const publish = fake.calls.filter((call) => call.method === 'PATCH').at(-1);
    assert.deepEqual(publish.body, { _status: 'published' });
    assert.equal(publish.query.draft, undefined, 'publishing is the one write that is not a draft');
    const unpublished = await service.act('posts.2', 'unpublish');
    assert.equal(unpublished.status, 'draft');
    await service.act('posts.2', 'publish');
    await service.write({ id: 'posts.2', field: 'views', value: 1 });
    const discarded = await service.act('posts.2', 'discard');
    assert.equal(discarded.status, 'published');
    assert.equal(field(discarded, 'views').value, 999, 'the draft is gone');
    assert.equal(fake.posts.get(2).views, 999, 'the live content never changed');
  });
});

test('discarding a document that was never published removes it', async () => {
  await withFake({ postCount: 5 }, async (fake, service) => {
    const result = await service.act('posts.5', 'discard');
    assert.equal(result, undefined);
    assert.equal(fake.posts.has(5), false);
  });
});

test('history lists versions newest first, and restoring one makes a draft without touching the live document', async () => {
  await withFake({}, async (fake, service) => {
    await service.write({ id: 'posts.2', field: 'views', value: 11 });
    await service.write({ id: 'posts.2', field: 'views', value: 22 });
    const history = await service.history('posts.2');
    cms.parseRemoteRevisions(through(history));
    assert.equal(history.length, 3);
    assert.ok(history[0].timestamp >= history[1].timestamp);
    const liveBefore = fake.posts.get(2).views;
    const restored = await service.restore('posts.2', history[1].id);
    assert.equal(fake.posts.get(2).views, liveBefore);
    assert.equal(field(restored, 'views').value, 11);
    assert.equal(fake.calls.filter((call) => call.method === 'POST' && /versions/.test(call.path)).at(-1).query.draft, 'true');
  });
});

test('create makes a draft that is listed, and delete removes it, and deleting twice is fine', async () => {
  await withFake({}, async (fake, service) => {
    const created = await service.create('posts');
    assert.equal(created.status, 'draft');
    const post = fake.calls.filter((call) => call.method === 'POST' && call.path === '/api/posts').at(-1);
    assert.equal(post.query.draft, 'true');
    assert.deepEqual(post.body, { _status: 'draft' });
    assert.equal(await service.remove([created.id]), 1);
    assert.equal(await service.remove([created.id]), 0);
    assert.equal(fake.posts.has(Number(created.id.split('.')[1])), false);
  });
});

test('relationship choices are searched by title with depth=0', async () => {
  await withFake({}, async (fake, service) => {
    const options = await service.references(['posts'], 'Post 2');
    cms.parseRemoteReferenceOptions(through(options));
    const call = fake.calls.filter((entry) => entry.path === '/api/posts').at(-1);
    assert.equal(call.query.depth, '0');
    assert.equal(call.query['where[title][like]'], 'Post 2');
    assert.ok(options.every((option) => option.id.startsWith('posts.')));
  });
});

test('an upload is multipart to the media collection, capped, and answers with the new asset', async () => {
  await withFake({}, async (fake, service) => {
    const asset = await service.upload('image', { name: 'photo one.png', bytes: new Uint8Array([1, 2, 3]) });
    cms.parseRemoteAsset(through(asset));
    assert.match(asset.id, /^image-media-\d+$/);
    assert.match(asset.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/file\//);
    const call = fake.calls.filter((entry) => entry.path === '/api/media' && entry.method === 'POST').at(-1);
    assert.ok(call.authorization.startsWith('users API-Key'));
    const big = await failure(() => service.upload('image', { name: 'big.png', bytes: new Uint8Array(51 * 1024 * 1024) }));
    assert.equal(big.failure, 'tooLarge');
    assert.equal(service.uploadBytesMax, 50 * 1024 * 1024);
  });
});

test('collections an account may not read are left out, and collections the form names are used when the server lists none', async () => {
  clearPayloadSessions();
  clearPayloadSchemas();
  const fake = await fakePayload({
    route: (request, response) =>
      request.url === '/api/access' ? (response.writeHead(403, { 'content-type': 'application/json' }), response.end('{}'), true) : false,
  });
  const named = payloadRemoteService(target(fake.base), { named: ['posts'] });
  assert.deepEqual(
    (await named.collections()).map((collection) => collection.name),
    ['posts'],
  );
  const none = payloadRemoteService(target(fake.base), { named: [] });
  clearPayloadSchemas();
  assert.equal((await failure(() => none.collections()))?.failure, 'forbidden');
  await fake.close();
});

test('without GraphQL the schema comes from sampled documents, and still edits', async () => {
  await withFake({ graphql: false }, async (fake, service) => {
    const document = await service.document('posts.1');
    cms.parseRemoteDocument(through(document));
    assert.equal(field(document, 'views').type.kind, 'number');
    assert.equal(field(document, 'featured').type.kind, 'boolean');
    assert.equal(field(document, 'body').type.kind, 'text', 'Lexical is recognised by its shape');
    await service.write({ id: 'posts.1', field: 'views', value: 5 });
    assert.equal(fake.calls.filter((call) => call.method === 'PATCH').at(-1).query.draft, 'true');
  });
});

// Goal: the CMS panel's Sanity reads tell drafts from published documents and type every field
// for editing, and a write is Sanity's own "edit" action on the draft — never a publish.
// Method: a stubbed fetch plays the Content Lake query and actions endpoints with raw rows
// (a draft beside its published document, a draft alone, a published alone); each request is
// recorded so the write's endpoint and body can be checked exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanityCollections,
  sanityDocument,
  sanityDocuments,
  sanityReferenceOptions,
  sanityWriteDraft,
} = require('#dist/electron/content/sanityContent.js');

const TARGET = { projectId: 'abc123', dataset: 'production', token: 'editor-key' };

function playSanity(answer) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, auth: init.headers.Authorization });
    return new Response(JSON.stringify(answer(String(url), body)), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('collections are the document types, with a count each', async () => {
  const sanity = playSanity((url, body) =>
    body.query.startsWith('array::unique')
      ? { result: ['sermon', 'campus', 'sanity.imageAsset'] }
      : { result: { c0: 12, c1: 296 } },
  );
  try {
    const collections = await sanityCollections(TARGET);
    assert.deepEqual(collections, [
      { name: 'campus', count: 12, icon: undefined },
      { name: 'sermon', count: 296, icon: undefined },
    ]);
    assert.match(
      sanity.calls[0].url,
      /^https:\/\/abc123\.api\.sanity\.io\/v[\d-]+\/data\/query\/production\?perspective=raw$/,
    );
    assert.equal(sanity.calls[0].auth, 'Bearer editor-key');
  } finally {
    sanity.restore();
  }
});

test('a draft beside its published document reads as edited, alone as draft', async () => {
  const sanity = playSanity(() => ({
    result: [
      { _id: 'drafts.a', preview: { title: 'A (draft)' }, _updatedAt: '2026-10-30' },
      { _id: 'a', preview: { title: 'A' }, _updatedAt: '2026-10-01' },
      { _id: 'drafts.b', preview: { title: 'B' }, _updatedAt: '2026-10-29' },
      { _id: 'c', preview: { title: 'C' }, _updatedAt: '2026-09-01' },
      { _id: 'versions.r1.c', preview: { title: 'C in a release' } },
    ],
  }));
  try {
    const { documents, orderable } = await sanityDocuments(TARGET, 'campus');
    assert.equal(orderable, false, 'no ranks, so not an ordered collection');
    assert.deepEqual(
      documents.map((document) => [document.id, document.title, document.status]),
      [
        ['a', 'A (draft)', 'changed'],
        ['b', 'B', 'draft'],
        ['c', 'C', 'published'],
      ],
    );
  } finally {
    sanity.restore();
  }
});

test('a document shows its draft, every field typed, with its assets', async () => {
  const sanity = playSanity((url, body) => {
    if (body.query.includes('originalFilename')) {
      assert.deepEqual(body.params.ids, ['image-1-10x10-png']);
      return {
        result: [
          {
            _id: 'image-1-10x10-png',
            url: 'https://cdn.sanity.io/i.png',
            originalFilename: 'p.png',
          },
        ],
      };
    }
    return {
      result: [
        { _id: 'a', _type: 'campus', name: 'Old', _updatedAt: '2026-10-01T09:00:00Z' },
        {
          _id: 'drafts.a',
          _type: 'campus',
          _rev: 'r',
          _updatedAt: '2026-10-30T12:00:00Z',
          name: 'Donaldsonville',
          hasSermons: false,
          slug: { _type: 'slug', current: 'dvl' },
          location: { _type: 'geopoint', lat: 30.1, lng: -90 },
          description: 'Line one\nLine two',
          opened: '2020-01-05',
          body: [{ _type: 'block', children: [] }],
          photo: { _type: 'image', asset: { _type: 'reference', _ref: 'image-1-10x10-png' } },
          orderRank: '0|i00007:',
        },
      ],
    };
  });
  const schema = {
    fields: [
      { name: 'name', title: 'Name', description: '', required: true, type: undefined },
      { name: 'body', title: '', description: '', required: false, type: { kind: 'richText' } },
    ],
    hidden: new Set(['orderRank']),
  };
  try {
    const document = await sanityDocument(TARGET, 'a', () => schema);
    assert.equal(document.status, 'changed');
    assert.equal(document.editedAt, '2026-10-30T12:00:00Z', 'the draft was edited');
    assert.equal(document.publishedAt, '2026-10-01T09:00:00Z', 'the published one changed then');
    const fields = Object.fromEntries(
      document.fields.map((field) => [field.name, [field.type.kind, field.value]]),
    );
    assert.deepEqual(
      document.fields.slice(0, 2).map((field) => [field.name, field.required]),
      [
        ['name', true],
        ['body', false],
      ],
      'the schema fields first, in its order',
    );
    assert.deepEqual(fields['name'], ['string', 'Donaldsonville'], 'the draft, not the published');
    assert.deepEqual(fields['hasSermons'], ['boolean', false]);
    assert.deepEqual(fields['slug'], ['slug', { _type: 'slug', current: 'dvl' }]);
    assert.equal(fields['location'][0], 'geopoint');
    assert.equal(fields['description'][0], 'text');
    assert.equal(fields['opened'][0], 'date');
    assert.equal(fields['body'][0], 'richText');
    assert.equal(fields['photo'][0], 'image');
    assert.equal('_rev' in fields, false, 'system fields are not offered');
    assert.equal('orderRank' in fields, false, 'hidden fields are not offered');
    const bare = await sanityDocument(TARGET, 'a', () => undefined);
    assert.equal(
      bare.fields.some((field) => field.name === 'orderRank'),
      false,
      'the rank is hidden even with no schema to say so',
    );
    assert.deepEqual(document.assets, [
      { id: 'image-1-10x10-png', url: 'https://cdn.sanity.io/i.png', filename: 'p.png' },
    ]);
  } finally {
    sanity.restore();
  }
});

test('a write sets or removes one whole field on the draft', async () => {
  const sanity = playSanity(() => ({ transactionId: 't1' }));
  try {
    const location = { _type: 'geopoint', lat: 30.2, lng: -90 };
    await sanityWriteDraft(TARGET, { id: 'a', field: 'location', value: location });
    await sanityWriteDraft(TARGET, { id: 'a', field: 'photo', value: undefined });
    const [set, unset] = sanity.calls;
    assert.match(set.url, /\/data\/actions\/production$/);
    assert.deepEqual(set.body, {
      actions: [
        {
          actionType: 'sanity.action.document.edit',
          publishedId: 'a',
          draftId: 'drafts.a',
          patch: { set: { location } },
        },
      ],
    });
    assert.deepEqual(unset.body.actions[0].patch, { unset: ['photo'] });
    assert.equal(JSON.stringify(set.body).includes('publish"'), false);
    await assert.rejects(
      () => sanityWriteDraft(TARGET, { id: 'drafts.a', field: 'x', value: 1 }),
      /published id/,
    );
  } finally {
    sanity.restore();
  }
});

test('reference options are published documents of the named types, by title', async () => {
  const sanity = playSanity((url, body) => {
    assert.deepEqual(body.params.types, ['campus']);
    assert.match(url, /perspective=published$/);
    return {
      result: [
        { _id: 'b', _type: 'campus', title: 'Rosepine' },
        { _id: 'a', _type: 'campus', title: 'Donaldsonville' },
      ],
    };
  });
  try {
    const options = await sanityReferenceOptions(TARGET, ['campus']);
    assert.deepEqual(
      options.map((option) => option.title),
      ['Donaldsonville', 'Rosepine'],
    );
    assert.deepEqual(await sanityReferenceOptions(TARGET, []), [], 'no types, no request');
    assert.equal(sanity.calls.length, 1);
  } finally {
    sanity.restore();
  }
});

test('a collection whose documents all carry a rank is listed in rank order', async () => {
  const sanity = playSanity(() => ({
    result: [
      { _id: 'late', preview: { title: 'Late' }, orderRank: '0|i0000f:' },
      { _id: 'early', preview: { title: 'Early' }, orderRank: '0|i00007:' },
      { _id: 'drafts.early', preview: { title: 'Early (draft)' }, orderRank: '0|i00007:' },
    ],
  }));
  try {
    const { documents, orderable } = await sanityDocuments(TARGET, 'booklet');
    assert.equal(orderable, true);
    assert.deepEqual(
      documents.map((document) => document.id),
      ['early', 'late'],
    );
  } finally {
    sanity.restore();
  }
});

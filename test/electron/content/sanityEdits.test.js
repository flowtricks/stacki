// Goal: new items are drafts, deletes do what Sanity Studio's Delete does (published with its
// draft, or a never-published draft discarded), and a move writes one rank between the new
// neighbours to the moved document's published and draft versions. Method: a stubbed fetch plays
// Sanity's query, actions and mutate endpoints; each request's body is checked exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanityAct,
  sanityCreateDraft,
  sanityDelete,
  sanityMove,
} = require('#dist/electron/content/sanityEdits.js');

const TARGET = { projectId: 'abc123', dataset: 'production', token: 'key' };

function playSanity(answer) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(String(url)).pathname, body });
    return new Response(JSON.stringify(answer(body) ?? {}), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('a new item is a draft of the type, ranked last in an ordered collection', async () => {
  const sanity = playSanity((body) =>
    body.query ? { result: '0|i00007:' } : { transactionId: 't' },
  );
  try {
    const made = await sanityCreateDraft(TARGET, 'booklet', { orderable: true });
    const create = sanity.calls.find((call) => call.path.endsWith('/actions/production'));
    const [action] = create.body.actions;
    assert.equal(action.actionType, 'sanity.action.document.create');
    assert.equal(action.attributes._id, `drafts.${made.id}`);
    assert.equal(action.attributes._type, 'booklet');
    assert.ok(action.attributes.orderRank > '0|i00007:', action.attributes.orderRank);
    assert.equal(made.status, 'draft');
  } finally {
    sanity.restore();
  }
});

test('delete takes published and draft; a draft alone is discarded', async () => {
  const sanity = playSanity((body) =>
    body.query ? { result: ['a', 'drafts.a', 'drafts.b'] } : { transactionId: 't' },
  );
  try {
    assert.equal(await sanityDelete(TARGET, ['a', 'b', 'gone']), 2);
    const query = sanity.calls[0];
    assert.deepEqual(query.body.params.ids, [
      'a',
      'drafts.a',
      'b',
      'drafts.b',
      'gone',
      'drafts.gone',
    ]);
    assert.deepEqual(sanity.calls[1].body.actions, [
      {
        actionType: 'sanity.action.document.delete',
        publishedId: 'a',
        includeDrafts: ['drafts.a'],
      },
      { actionType: 'sanity.action.document.discard', draftId: 'drafts.b' },
    ]);
  } finally {
    sanity.restore();
  }
});

test('a move writes one rank between the neighbours, to the published and the draft', async () => {
  const sanity = playSanity((body) => {
    if (body.query?.includes('orderRank}')) {
      return {
        result: [
          { _id: 'first', orderRank: '0|i00007:' },
          { _id: 'second', orderRank: '0|i0000f:' },
        ],
      };
    }
    if (body.query) {
      return { result: ['moved', 'drafts.moved'] };
    }
    return { transactionId: 't' };
  });
  try {
    await sanityMove(TARGET, {
      collection: 'booklet',
      id: 'moved',
      after: 'first',
      before: 'second',
    });
    const mutate = sanity.calls.find((call) => call.path.endsWith('/mutate/production'));
    const ranks = mutate.body.mutations.map((mutation) => mutation.patch.set.orderRank);
    assert.deepEqual(
      mutate.body.mutations.map((mutation) => mutation.patch.id),
      ['moved', 'drafts.moved'],
    );
    assert.equal(ranks[0], ranks[1]);
    assert.ok('0|i00007:' < ranks[0] && ranks[0] < '0|i0000f:', ranks[0]);
  } finally {
    sanity.restore();
  }
});

test('a move whose neighbour has gone refuses rather than guessing', async () => {
  const sanity = playSanity((body) => (body.query ? { result: [] } : {}));
  try {
    await assert.rejects(
      () =>
        sanityMove(TARGET, {
          collection: 'booklet',
          id: 'moved',
          after: 'first',
          before: undefined,
        }),
      /list changed/,
    );
  } finally {
    sanity.restore();
  }
});

// Publish, discard and unpublish are Sanity's own actions, refused when they cannot apply.
test('document actions are Sanity’s own, refused when they cannot apply', async () => {
  const existing = new Set(['p', 'drafts.p']);
  const sanity = playSanity((body) =>
    body.query
      ? { result: body.params.ids.filter((id) => existing.has(id)) }
      : { transactionId: 't' },
  );
  try {
    await sanityAct(TARGET, 'p', 'publish');
    await sanityAct(TARGET, 'p', 'discard');
    await sanityAct(TARGET, 'p', 'unpublish');
    const actions = sanity.calls
      .filter((call) => call.body.actions)
      .map((call) => call.body.actions[0]);
    assert.deepEqual(actions, [
      { actionType: 'sanity.action.document.publish', draftId: 'drafts.p', publishedId: 'p' },
      { actionType: 'sanity.action.document.discard', draftId: 'drafts.p' },
      { actionType: 'sanity.action.document.unpublish', draftId: 'drafts.p', publishedId: 'p' },
    ]);
    existing.delete('drafts.p');
    await assert.rejects(() => sanityAct(TARGET, 'p', 'publish'), /no changes to publish/);
  } finally {
    sanity.restore();
  }
});

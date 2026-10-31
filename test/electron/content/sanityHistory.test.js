// Goal: a document's history lists its saved versions newest first with who made each, and
// restoring one makes it the draft with Sanity's own replace-draft action — never a publish.
// Method: a stubbed fetch plays the history, members and actions endpoints; the restore's
// request body is checked exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanityRestore, sanityRevisions } = require('#dist/electron/content/sanityHistory.js');

const TARGET = { projectId: 'abc123', dataset: 'production', token: 'key' };

function playSanity(answer) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    return new Response(answer(String(url)), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('revisions are read newest first, with members’ names', async () => {
  const sanity = playSanity((url) =>
    url.includes('/users/')
      ? JSON.stringify([{ id: 'u1', displayName: 'Tim' }])
      : [
          JSON.stringify({ id: 'tx2', timestamp: '2026-10-30T10:00:00Z', author: 'u1' }),
          JSON.stringify({ id: 'tx1', timestamp: '2026-10-29T10:00:00Z', author: 'u9' }),
        ].join('\n'),
  );
  try {
    const revisions = await sanityRevisions(TARGET, 'a');
    assert.deepEqual(revisions, [
      { id: 'tx2', timestamp: '2026-10-30T10:00:00Z', author: 'Tim' },
      { id: 'tx1', timestamp: '2026-10-29T10:00:00Z', author: 'Someone' },
    ]);
    assert.match(sanity.calls[0].url, /\/history\/production\/transactions\/a,drafts\.a\?/);
  } finally {
    sanity.restore();
  }
});

test('restoring a version replaces the draft with it, system fields left to Sanity', async () => {
  const sanity = playSanity((url) =>
    url.includes('/documents/')
      ? JSON.stringify({
          documents: [{ _id: 'a', _type: 'campus', _rev: 'r1', _updatedAt: 'x', name: 'Old' }],
        })
      : JSON.stringify({ transactionId: 't' }),
  );
  try {
    await sanityRestore(TARGET, 'a', 'tx1');
    const action = sanity.calls[1].body.actions[0];
    assert.deepEqual(action, {
      actionType: 'sanity.action.document.replaceDraft',
      publishedId: 'a',
      attributes: { _id: 'drafts.a', _type: 'campus', name: 'Old' },
    });
  } finally {
    sanity.restore();
  }
});

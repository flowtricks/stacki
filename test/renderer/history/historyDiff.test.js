// Goal: unified patches keep correct old/new line numbers and explicit failures.
// Methodology: parse root, deletion, mixed and multi-hunk fixtures, then exercise
// malformed hunks, boundary limits and the actual IPC bridge with a stub transport.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { parseHistoryPatch } = load('src/features/history/historyDiffModel.ts');
const { readHistoryDiff } = load('src/features/history/historyDiffBridge.ts');

test('line numbers distinguish both sides of a change', () => {
  assert.deepEqual(parseHistoryPatch('@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+++code\n'), [
    { kind: 'hunk', text: '@@ -3,2 +3,3 @@' },
    { kind: 'context', text: 'keep', before: 3, after: 3 },
    { kind: 'deleted', text: 'old', before: 4 },
    { kind: 'added', text: 'new', after: 4 },
    { kind: 'added', text: '++code', after: 5 },
  ]);
  assert.deepEqual(parseHistoryPatch('@@ -0,0 +1 @@\n+new\n')[1], {
    kind: 'added',
    text: 'new',
    after: 1,
  });
  assert.deepEqual(parseHistoryPatch('@@ -1 +0,0 @@\n-old\n')[1], {
    kind: 'deleted',
    text: 'old',
    before: 1,
  });
  const rows = parseHistoryPatch('@@ -1 +1 @@\n-a\n+b\n@@ -99 +99 @@\n-c\n+d\n');
  assert.equal(rows.at(-1).after, 99);
  assert.equal(parseHistoryPatch('Binary files a/image and b/image differ')[0].kind, 'metadata');
  assert.equal(parseHistoryPatch('rename from old\nrename to new\n').length, 2);
  assert.equal(parseHistoryPatch('@@ -0,0 +1 @@\n+line\n\\ No newline at end of file')[2].kind, 'metadata');
});

test('malformed and oversized hunks fail loudly', () => {
  assert.throws(() => parseHistoryPatch('@@ -1,2 +1,2 @@\n one'), /incomplete original hunk/);
  assert.throws(() => parseHistoryPatch('@@ -1 +1 @@\n?broken'), /unknown hunk line/);
  assert.throws(() => parseHistoryPatch('@@ -1 +1 @@\n+one\n+two'), /added line exceeds/);
  assert.throws(() => parseHistoryPatch('@@ -999999999999999999 +1 @@'), /invalid line number/);
  assert.throws(() => parseHistoryPatch('a'.repeat(500_001)), /character limit/);
  assert.throws(() => parseHistoryPatch('\n'.repeat(10_000)), /line limit/);
});

test('diff bridge validates both sides and represents transport errors', async () => {
  const request = {
    projectPath: '/project',
    commit: 'a'.repeat(40),
    path: 'file',
    from: undefined,
  };
  global.window = {
    avb: {
      gitCommitDiff: async (payload) => {
        assert.deepEqual(payload, request);
        return { ok: true, value: 'patch' };
      },
    },
  };
  try {
    assert.deepEqual(await readHistoryDiff(request), { ok: true, value: 'patch' });
    window.avb.gitCommitDiff = async () => {
      throw new Error('Offline');
    };
    assert.deepEqual(await readHistoryDiff(request), { ok: false, error: 'Offline' });
    window.avb.gitCommitDiff = async () => ({ ok: true, value: 3 });
    await assert.rejects(readHistoryDiff(request));
    await assert.rejects(readHistoryDiff({ ...request, commit: 'HEAD' }), /full commit hash/);
  } finally {
    delete global.window;
  }
});

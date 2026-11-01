// Goal: history data reaches the renderer only after complete bounded parsing.
// Methodology: parse valid logs, files, and worktrees, reject malformed and
// duplicate identities, then verify transport failures remain Result values.
const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../../helpers/rendererModule')('src/features/history/historyBridge.ts');

const file = {
  status: 'M',
  path: 'src/pages/index.astro',
  from: undefined,
  kind: 'page',
  label: 'Home',
};
const commit = {
  files: [file],
  hash: '0123456789abcdef',
  shortHash: '0123456',
  author: 'A Person',
  email: 'person@example.com',
  when: '2026-09-16T10:00:00Z',
  subject: 'Changed Home',
  parents: ['parent'],
  refs: ['HEAD -> main'],
  isMerge: false,
};

test('history parsers preserve complete renderer records', () => {
  assert.deepEqual(history.parseHistoryLog({ commits: [commit], atEnd: true }), {
    commits: [commit],
    atEnd: true,
  });
  assert.deepEqual(history.parseHistoryFiles([{ ...file, status: undefined, staged: false }]), [{ ...file, status: undefined, staged: false }]);
  assert.deepEqual(history.parseHistoryWorktrees([{ path: '/project', head: '0123456', branch: 'main', detached: false, bare: false }]), [
    { path: '/project', head: '0123456', branch: 'main', detached: false, bare: false },
  ]);
});

test('history parsers reject incomplete, invalid, duplicate, and oversized data', () => {
  for (const value of [
    {},
    { commits: [{ ...commit, hash: undefined }], atEnd: true },
    { commits: [{ ...commit, files: [{ ...file, kind: 'mystery' }] }], atEnd: true },
    { commits: [commit, commit], atEnd: false },
    { commits: Array(100_001).fill(commit), atEnd: true },
  ]) {
    assert.throws(() => history.parseHistoryLog(value));
  }
  assert.throws(() =>
    history.parseHistoryFiles([
      { ...file, status: undefined, staged: false },
      { ...file, status: undefined, staged: false },
    ]),
  );
  assert.throws(() =>
    history.parseHistoryWorktrees([
      { path: '/project', head: undefined, branch: undefined, detached: false, bare: false },
      { path: '/project', head: undefined, branch: undefined, detached: false, bare: false },
    ]),
  );
});

test('history readers parse replies and preserve expected transport failures', async () => {
  const requests = [];
  global.window = {
    avb: {
      gitLog: async (payload) => {
        requests.push(payload);
        assert.equal(payload.withFiles, true);
        return { commits: [commit], atEnd: true };
      },
      gitAllFiles: async () => {
        throw new Error('repository unavailable');
      },
      gitWorktrees: async () => [],
    },
  };
  assert.equal((await history.readHistoryLog('/project', 0)).ok, true);
  assert.equal(requests[0].ref, undefined);
  assert.equal((await history.readHistoryLog('/project', 30, 'HEAD')).ok, true);
  assert.equal(requests[1].ref, 'HEAD');
  assert.equal(requests[1].skip, 30);
  assert.deepEqual(await history.readHistoryFiles('/project'), {
    ok: false,
    error: 'repository unavailable',
  });
  assert.deepEqual(await history.readHistoryWorktrees('/project'), { ok: true, value: [] });
  delete global.window;
});

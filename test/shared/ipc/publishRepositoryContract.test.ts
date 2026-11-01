// Goal: repository setup rejects malformed IPC and bounds account/repository inventories.
// Method: round-trip each action and mutate identifiers, revisions, kinds, and collection sizes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseRepositoryRequest, parseRepositoryResult } from '#dist/shared/ipc/publishRepository.js';
const revision = 'a'.repeat(64);
test('repository requests and results round-trip', () => {
  for (const request of [
    { action: 'list', account: 'work' },
    { action: 'connect', account: 'work', repository: 'work/site', revision },
    { action: 'create', account: 'work', name: 'site', private: true },
  ]) {
    assert.deepEqual(parseRepositoryRequest(request), request);
    assert.deepEqual(parseIpcPayload('publish:repository', { projectPath: '/site', request }), {
      projectPath: '/site',
      request,
    });
  }
  const ready = {
    ok: true,
    value: {
      connected: 'work/site',
      revision,
      repositories: ['work/site'],
      mode: 'editable',
      notice: '',
    },
  };
  assert.deepEqual(parseRepositoryResult(ready), ready);
  assert.deepEqual(parseRepositoryResult({ ok: false, error: 'Unavailable' }), {
    ok: false,
    error: 'Unavailable',
  });
});
test('repository requests reject unsafe identifiers and result excess', () => {
  for (const request of [
    undefined,
    {},
    { action: 'list', account: '' },
    { action: 'list', account: '-flag' },
    { action: 'list', account: 'a'.repeat(40) },
    { action: 'connect', account: 'work', repository: 'work/../outside', revision },
    { action: 'connect', account: 'work', repository: 'work/site', revision: 'old' },
    { action: 'create', account: 'work', name: '../outside', private: true },
    { action: 'create', account: 'work', name: 'site', private: 'yes' },
  ]) {
    assert.throws(() => parseRepositoryRequest(request));
  }
  for (const value of [
    { connected: 'bad', revision, repositories: [], mode: 'editable', notice: '' },
    {
      connected: '',
      revision,
      repositories: Array(501).fill('work/site'),
      mode: 'editable',
      notice: '',
    },
    { connected: '', revision, repositories: [], mode: 'other', notice: '' },
    { connected: '', revision, repositories: [], mode: 'editable', notice: 'x'.repeat(1001) },
  ]) {
    assert.throws(() => parseRepositoryResult({ ok: true, value }));
  }
});

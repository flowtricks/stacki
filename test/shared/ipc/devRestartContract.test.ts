// Goal: the `dev:restart` notice (shared/ipc/devRestart.ts) is parsed at the renderer's boundary: both known
// shapes pass, and everything else, including an address that is no http server's, is refused.
// Method: the pure parser, over a table of good and bad values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDevRestartNotice } from '#dist/shared/ipc/devRestart.js';

test('begun, done with an address and done without one pass', () => {
  assert.deepEqual(parseDevRestartNotice({ kind: 'begun' }), { kind: 'begun' });
  assert.deepEqual(parseDevRestartNotice({ kind: 'done', url: 'http://127.0.0.1:4321' }), { kind: 'done', url: 'http://127.0.0.1:4321' });
  assert.deepEqual(parseDevRestartNotice({ kind: 'done' }), { kind: 'done', url: undefined });
});

test('anything else is refused', () => {
  for (const bad of [
    undefined,
    'begun',
    {},
    { kind: 'ended' },
    { kind: 'done', url: 4321 },
    { kind: 'done', url: 'file:///etc/hosts' },
    { kind: 'done', url: 'nowhere' },
    { kind: 'done', url: `http://127.0.0.1/${'a'.repeat(300)}` },
  ]) {
    assert.throws(() => parseDevRestartNotice(bad), `${JSON.stringify(bad)} is refused`);
  }
});

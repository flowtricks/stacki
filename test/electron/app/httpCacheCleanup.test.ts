// Goal: the HTTP cache is cleared once per cleanup version, the version is remembered only after a clearing that
// finished, and a clearing that fails or hangs never keeps the app from starting.
// Method: the pure routine runs with a recorded clearCache and remember, for a fresh install, a done one, a later
// version's, a failure and a clearing that never settles; the stored flag goes through the real settings parser, with
// the values a damaged or older file can hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTTP_CACHE_CLEANUP_VERSION, cleanUpHttpCacheOnce } from '#dist/electron/app/httpCacheCleanup.js';
import { parseSettings } from '#dist/electron/app/mainValidation.js';

// A null as it reaches the parser: out of a stored file.
const NULL_FROM_JSON: unknown = JSON.parse('null');

function recorder(clearing: () => Promise<void> = () => Promise.resolve()) {
  const calls: string[] = [];
  return {
    calls,
    run: (doneVersion: number, waitMsMax = 1000) =>
      cleanUpHttpCacheOnce({
        doneVersion,
        waitMsMax,
        clearCache: () => {
          calls.push('clear');
          return clearing();
        },
        remember: (version) => calls.push(`remember ${version}`),
      }),
  };
}

test('the first launch clears, then remembers', async () => {
  const app = recorder();
  assert.equal(await app.run(0), 'cleared');
  assert.deepEqual(app.calls, ['clear', `remember ${HTTP_CACHE_CLEANUP_VERSION}`]);
});

test('a launch after the cleanup, or after a later version of it, clears nothing', async () => {
  for (const done of [HTTP_CACHE_CLEANUP_VERSION, HTTP_CACHE_CLEANUP_VERSION + 3]) {
    const app = recorder();
    assert.equal(await app.run(done), 'alreadyDone');
    assert.deepEqual(app.calls, []);
  }
});

test('a clearing that fails is not remembered, so the next launch tries again', async () => {
  const app = recorder(() => Promise.reject(new Error('disk')));
  assert.equal(await app.run(0), 'failed');
  assert.deepEqual(app.calls, ['clear']);
});

test('a clearing that never settles is given up on and not remembered', async () => {
  const app = recorder(() => new Promise<void>(() => undefined));
  assert.equal(await app.run(0, 20), 'timedOut');
  assert.deepEqual(app.calls, ['clear']);
});

test('the stored flag is parsed: kept when whole, read as never run when absent or damaged', () => {
  assert.equal(parseSettings({ sound: false, httpCacheCleanupVersion: 1 }).httpCacheCleanupVersion, 1);
  for (const damaged of [undefined, -1, 1.5, '1', true, NULL_FROM_JSON, {}]) {
    const parsed = parseSettings({ sound: false, codeChips: false, httpCacheCleanupVersion: damaged });
    assert.equal(parsed.httpCacheCleanupVersion, 0, String(damaged));
    assert.equal(parsed.codeChips, false, 'the other settings are kept');
  }
});

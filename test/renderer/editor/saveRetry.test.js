// Goal: brief sharing failures recover without replaying uncertain writes or conflicts.
// Method: control replies and time, checking the original checksum survives each
// attempt, retries stop at their bound, and transport exceptions are not swallowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { sendPageEditWithRetry } = load('src/ipc/saveRetry.ts');

const request = {
  pagePath: 'G:\\code\\site\\src\\pages\\index.astro',
  authoredChecksum: 'a'.repeat(64),
  edit: { tag: 'code-patch', hunks: [] },
};
const success = { ok: true, value: { source: 'after', checksum: 'b'.repeat(64), inverse: [] } };
const failure = (code, message) => ({ ok: false, error: { code, message } });

test('brief sharing violations retain the authored request until success', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const attempts = [];
    const waits = [];
    const result = await sendPageEditWithRetry(request, {
      wait: async (delay) => waits.push(delay),
      send: async (attempt) => {
        attempts.push(attempt);
        return attempts.length < 3 ? failure('filesystem', `${code}: file held open`) : success;
      },
    });
    assert.equal(result, success);
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((attempt) => attempt === request));
    assert.deepEqual(waits, [100, 250]);
  }
});

test('a persistent permission failure stops after four attempts', async () => {
  const answer = failure('filesystem', 'EACCES: permission denied');
  let attempts = 0;
  const waits = [];
  const result = await sendPageEditWithRetry(request, {
    wait: async (delay) => waits.push(delay),
    send: async () => {
      attempts += 1;
      return answer;
    },
  });
  assert.equal(result, answer);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 250, 500]);
});

test('only definite sharing failures can replay', async () => {
  const answers = [
    failure('write-race', 'EPERM'),
    failure('uncertain', 'EPERM'),
    failure('rejected', 'EPERM'),
    failure('missing', 'EPERM'),
    failure('filesystem', 'ENOSPC: disk full'),
    failure('backpressured', 'EPERM'),
    success,
  ];
  for (const answer of answers) {
    let attempts = 0;
    const result = await sendPageEditWithRetry(request, {
      wait: async () => assert.fail('No delay without a safely retryable failure'),
      send: async () => {
        attempts += 1;
        return answer;
      },
    });
    assert.equal(result, answer);
    assert.equal(attempts, 1);
  }
});

test('an outside change encountered on retry stops further attempts', async () => {
  const conflict = failure('rejected', 'Changed on disk');
  let attempts = 0;
  const result = await sendPageEditWithRetry(request, {
    wait: async () => {},
    send: async () => {
      attempts += 1;
      return attempts === 1 ? failure('filesystem', 'EPERM') : conflict;
    },
  });
  assert.equal(result, conflict);
  assert.equal(attempts, 2);
});

test('a transport exception is not evidence that the write failed', async () => {
  let attempts = 0;
  await assert.rejects(
    sendPageEditWithRetry(request, {
      wait: async () => assert.fail('A lost reply must not be replayed'),
      send: async () => {
        attempts += 1;
        throw new Error('IPC closed');
      },
    }),
    /IPC closed/,
  );
  assert.equal(attempts, 1);
});

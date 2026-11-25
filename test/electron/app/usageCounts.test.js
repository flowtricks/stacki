// Daily usage counting: verify that one request carries no identifying payload,
// and that network failures cannot interrupt project editing. The date case
// pins the UTC boundary used for the local once-per-day guard.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendUsageCount, shouldCountUsage, usageDay } = require('#dist/electron/app/usageCounts.js');

test('a usage count sends only an empty POST to the first-party endpoint', async () => {
  const controller = new AbortController();
  let sent = 0;
  const success = await sendUsageCount({ signal: controller.signal }, async (url, options) => {
    sent += 1;
    assert.match(url, /^https:\/\/stacki-usage-counts\./);
    assert.equal(options.method, 'POST');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return new Response(undefined, { status: 204 });
  });
  assert.equal(success, true);
  assert.equal(sent, 1);
});

test('offline and rejected requests cannot interrupt project editing', async () => {
  const controller = new AbortController();
  const offline = await sendUsageCount({ signal: controller.signal }, async () => {
    throw new Error('offline');
  });
  const rejected = await sendUsageCount({ signal: controller.signal }, async () => new Response(undefined, { status: 503 }));
  assert.equal(offline, false);
  assert.equal(rejected, false);
});

test('the local usage guard uses a UTC calendar day', () => {
  assert.equal(usageDay(new Date('2026-10-08T23:59:59.999Z')), '2026-10-08');
  assert.equal(usageDay(new Date('2026-10-09T00:00:00.000Z')), '2026-10-09');
});

test('development, opt-out, missing notice, and repeat openings send no count', () => {
  const active = {
    packaged: true,
    enabled: true,
    noticeVersion: 1,
    lastAttemptDay: undefined,
  };
  assert.equal(shouldCountUsage(active, '2026-10-08'), true);
  assert.equal(shouldCountUsage({ ...active, packaged: false }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, enabled: false }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, noticeVersion: 0 }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, lastAttemptDay: '2026-10-08' }, '2026-10-08'), false);
});

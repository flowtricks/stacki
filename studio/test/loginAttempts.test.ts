// Goal: consumed OAuth attempts remain single-use across restarts, errors, and capacity limits.
// Method: share transactional fixture storage between coordinators and advance a controlled clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginAttempts, loginAttemptsMax, parseLoginClaims } from '../src/features/auth/loginAttempts';
import { SignInFailure } from '../src/features/auth/signInFailure';
import { loginAttemptFixture } from './loginAttemptFixture';

test('a restart cannot exchange a consumed authorization again', async () => {
  const fixture = loginAttemptFixture();
  const state = crypto.randomUUID();
  const expires = Date.now() + 60_000;
  const first = await fixture.create().run(state, expires, async () => new Response('done'));
  assert.ok(first.ok);
  assert.equal(await first.value.text(), 'done');
  assert.deepEqual(await fixture.create().run(state, expires, async () => assert.fail('Must not exchange again')), { ok: false, error: 'expired' });
});

test('independent coordinators atomically claim the same attempt once', async () => {
  const fixture = loginAttemptFixture();
  const state = crypto.randomUUID();
  const expires = Date.now() + 60_000;
  let calls = 0;
  const action = async () => {
    calls++;
    return new Response('done');
  };
  const results = await Promise.all([fixture.create().run(state, expires, action), fixture.create().run(state, expires, action)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal(calls, 1);
});

test('failed exchanges are shared without extending GitHub cooldowns', async () => {
  const attempts = loginAttemptFixture().create();
  const state = crypto.randomUUID();
  const expires = Date.now() + 60_000;
  const failure = new SignInFailure('rate-limit', 'token', 429, 'http', Date.now() + 30_000);
  let calls = 0;
  const action = async () => {
    calls++;
    throw failure;
  };
  for (let index = 0; index < 3; index++) {
    await assert.rejects(attempts.run(state, expires, action), (error: unknown) => error === failure);
  }
  assert.equal(calls, 1);
});

test('storage failure prevents token exchange instead of losing the single-use record', async () => {
  const failure = new Error('Storage unavailable');
  const attempts = new LoginAttempts(async () => {
    throw failure;
  });
  await assert.rejects(
    attempts.run(crypto.randomUUID(), Date.now() + 60_000, async () => assert.fail('No exchange')),
    (error: unknown) => error === failure,
  );
});

test('full storage retains live claims and prunes expired claims before accepting another', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const fixture = loginAttemptFixture();
  const attempts = fixture.create();
  for (let index = 0; index < loginAttemptsMax; index++) {
    await attempts.run(crypto.randomUUID(), now + 1000, async () => new Response('done'));
  }
  const state = crypto.randomUUID();
  for (const coordinator of [attempts, fixture.create()]) {
    assert.deepEqual(await coordinator.run(state, now + 1000, async () => assert.fail('No eviction of live claims')), { ok: false, error: 'capacity' });
  }
  now += 1001;
  const response = await attempts.run(state, now + 1000, async () => new Response('ready'));
  assert.ok(response.ok);
  assert.equal(await response.value.text(), 'ready');
  assert.equal(parseLoginClaims(await fixture.storage.get('auth/login-attempts'), now).length, 1);
});

test('stored attempts reject malformed, oversized, and duplicate records', () => {
  const now = Date.now();
  const good = { state: crypto.randomUUID(), expires: now + 1000 };
  assert.deepEqual(parseLoginClaims(undefined, now), []);
  assert.deepEqual(parseLoginClaims([good], now), [good]);
  const invalid: readonly unknown[] = [
    null,
    {},
    'claims',
    [null],
    [true],
    [{}],
    [{ ...good, state: 'not-a-UUID' }],
    [{ ...good, state: 123 }],
    [{ ...good, expires: '1000' }],
    [{ ...good, expires: Infinity }],
    [{ ...good, expires: -1 }],
    [{ ...good, expires: 1.5 }],
    [{ ...good, expires: now + 600_001 }],
    [good, good],
    Array(loginAttemptsMax + 1).fill(good),
  ];
  for (const value of invalid) {
    assert.throws(() => parseLoginClaims(value, now), /stored login|Stored login/);
  }
});

test('expired attempts and invalid invariants cannot reach GitHub', async () => {
  const attempts = loginAttemptFixture().create();
  const action = async () => assert.fail('No exchange');
  assert.deepEqual(await attempts.run(crypto.randomUUID(), Date.now() - 1, action), {
    ok: false,
    error: 'expired',
  });
  await assert.rejects(attempts.run('invalid', Date.now() + 1000, action), /Login state must be a UUID/);
  await assert.rejects(attempts.run(crypto.randomUUID(), Infinity, action), /Login state must have a bounded expiry/);
});

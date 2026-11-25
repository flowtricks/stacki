// Goal: publishing outlives browser activity while finished or broken containers can sleep.
// Method: exercise the idle guard with bounded status responses and injected lifecycle actions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublishIdleGuard } from '../src/cloudflare/publishIdleGuard';

test('active publishing keeps renewing and terminal states allow sleep', async () => {
  const guard = new PublishIdleGuard();
  let renewals = 0;
  let stops = 0;
  const actions = {
    read: async () => Response.json({ kind: 'building', id: 'job' }),
    renew: () => {
      renewals++;
    },
    stop: async () => {
      stops++;
    },
  };
  for (let check = 0; check < 30; check++) {
    await guard.expire(actions);
  }
  assert.equal(renewals, 30);
  assert.equal(stops, 0);
  for (const kind of ['idle', 'committed', 'failed', 'review-open']) {
    await guard.expire({ ...actions, read: async () => Response.json({ kind }) });
  }
  assert.equal(stops, 4);
});

test('invalid or unreachable status gets bounded recovery time, reset by a healthy job', async () => {
  const guard = new PublishIdleGuard();
  let renewals = 0;
  let stops = 0;
  const actions = {
    read: async () => {
      throw new Error('Unreachable');
    },
    renew: () => {
      renewals++;
    },
    stop: async () => {
      stops++;
    },
  };
  for (const response of [
    new Response('<html>Restarting</html>', { status: 503 }),
    Response.json({ kind: 'building', id: '' }),
    Response.json({ kind: 'made-up' }),
    Response.json({ kind: 'idle', padding: 'a'.repeat(32_768) }),
  ]) {
    await guard.expire({ ...actions, read: async () => response });
  }
  assert.equal(stops, 0);
  await guard.expire({
    ...actions,
    read: async () => Response.json({ kind: 'building', id: 'job' }),
  });
  for (let check = 0; check < 9; check++) {
    await guard.expire(actions);
  }
  assert.equal(stops, 0);
  await guard.expire(actions);
  assert.equal(stops, 1);
  assert.equal(renewals, 14);
});

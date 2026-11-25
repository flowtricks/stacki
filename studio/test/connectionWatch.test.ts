// Goal: cold container startup must not cause premature reconnect loops, while
// established but silent sockets still recover. Method: advance mocked timers
// across connection, heartbeat and cleanup boundaries on a real EventTarget.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchConnection } from '../src/features/collaboration/connectionWatch';

test('cold connection gets the startup budget and open sockets keep the heartbeat budget', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventTarget();
  let recoveries = 0;
  const stop = watchConnection(socket, () => recoveries++);
  t.mock.timers.tick(76_000);
  assert.equal(recoveries, 0, 'A cold handshake must not restart after 75 seconds');
  socket.dispatchEvent(new Event('open'));
  t.mock.timers.tick(74_000);
  assert.equal(recoveries, 0);
  socket.dispatchEvent(new Event('message'));
  t.mock.timers.tick(74_000);
  assert.equal(recoveries, 0, 'Incoming traffic renews the established connection');
  t.mock.timers.tick(1000);
  assert.equal(recoveries, 1, 'A silent open socket still recovers after 75 seconds');
  stop();
  socket.dispatchEvent(new Event('message'));
  t.mock.timers.tick(240_000);
  assert.equal(recoveries, 1, 'Cleanup removes timers and listeners');
});

test('a handshake that never opens eventually retries once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let recoveries = 0;
  const stop = watchConnection(new EventTarget(), () => recoveries++);
  t.mock.timers.tick(239_999);
  assert.equal(recoveries, 0);
  t.mock.timers.tick(1);
  assert.equal(recoveries, 1);
  stop();
});

// Goal: live peers remain connected, while revoked and abandoned peers release compute.
// Method: drive real WebSocket pairs with bounded heartbeat intervals and deadlines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { maintainConnection } from '../src/features/collaboration/connectionLease';

test(
  'access refresh and heartbeats keep an authorized collaboration socket open',
  { timeout: 5000 },
  async () => {
    const { server, client, socket } = await connectedPair();
    let pings = 0;
    client.on('message', (data) => {
      if (data.toString() === JSON.stringify({ type: 'ping' })) {
        pings++;
        client.send(JSON.stringify({ type: 'pong' }));
      }
    });
    let checks = 0;
    maintainConnection(
      socket,
      async () => {
        checks++;
        return true;
      },
      { checkEvery: 50, pingEvery: 500 },
    );
    try {
      // Observe actual traffic instead of assuming heavily parallel tests can
      // service a 10 ms heartbeat or finish three checks within 150 ms.
      while (checks < 3 || pings < 2) {
        assert.equal(client.readyState, WebSocket.OPEN);
        await delay(25);
      }
      assert.ok(checks >= 3);
      assert.equal(client.readyState, WebSocket.OPEN);
      const message = new Promise<string>((resolve) => {
        const received = (data: RawData) => {
          if (String(data) === 'still connected') {
            client.off('message', received);
            resolve(String(data));
          }
        };
        client.on('message', received);
      });
      socket.send('still connected');
      assert.equal(await message, 'still connected');
    } finally {
      client.terminate();
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('revoked access closes the socket instead of silently extending its authorization', async () => {
  const { server, client, socket } = await connectedPair();
  maintainConnection(socket, async () => false, { checkEvery: 10, pingEvery: 100 });
  const result: unknown[] = await once(client, 'close');
  const code = result[0];
  assert.equal(code, 4001);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectedPair() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, 'open');
  const result: unknown[] = await connection;
  const socket = result[0];
  assert.ok(socket instanceof WebSocket);
  return { server, client, socket };
}

test(
  'a client that stops responding is disconnected even when the transport remains open',
  {
    timeout: 5000,
  },
  async () => {
    const { server, client, socket } = await connectedPair();
    client.once('message', () => client.send(JSON.stringify({ type: 'pong' })));
    maintainConnection(socket, undefined, { pingEvery: 15 });
    await once(client, 'close');
    assert.equal(client.readyState, WebSocket.CLOSED);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
);

test(
  'a client that never replies cannot keep a container awake indefinitely',
  {
    timeout: 5000,
  },
  async () => {
    const { server, client, socket } = await connectedPair();
    let pings = 0;
    client.on('message', () => pings++);
    try {
      maintainConnection(socket, undefined, { pingEvery: 30 });
      await once(client, 'close');
      assert.equal(client.readyState, WebSocket.CLOSED);
      assert.ok(pings <= 3, 'outgoing heartbeats cannot renew their own lease');
    } finally {
      client.terminate();
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  'Vite ping messages renew the lease without a document-style pong response',
  {
    timeout: 5000,
  },
  async () => {
    const { server, client, socket } = await connectedPair();
    let pings = 0;
    client.on('message', () => {
      pings++;
      client.send(JSON.stringify({ type: 'ping' }));
    });
    try {
      maintainConnection(socket, undefined, { pingEvery: 100 });
      const deadline = Date.now() + 3000;
      while (pings < 5 && Date.now() < deadline) {
        await delay(25);
      }
      assert.ok(pings >= 5, 'preview traffic survives beyond the initial lease');
      assert.equal(client.readyState, WebSocket.OPEN);
    } finally {
      client.terminate();
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

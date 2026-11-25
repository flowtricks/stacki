import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Room } from '../src/features/collaboration/rooms';
import { record } from '../src/shared/validation';

test('presence retains the authenticated GitHub identity despite spoofed client metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-presence-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const room = new Room(root, 'src/pages/index.astro');
  let client: WebSocket | undefined;
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Test</h1>');
    await room.initialize();
    if (!server.address()) {
      await once(server, 'listening');
    }
    server.on('connection', (socket) => room.attach(socket, { id: 123, login: 'editor' }));
    const address = server.address();
    assert.ok(typeof address === 'object' && address);
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const received = new Promise<unknown>((resolve, reject) => {
      client?.on('error', reject);
      client?.on('message', (bytes) => {
        const data = record(JSON.parse(bytes.toString()));
        if (data['type'] !== 'presence' || !Array.isArray(data['peers'])) {
          return;
        }
        const peer = record(data['peers'][0]);
        if (peer['selection'] === '0.0') {
          resolve(peer);
        }
      });
    });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'presence', name: 'imposter', githubId: 999, selection: '0.0' }));
    const peer = record(await received);
    assert.equal(peer['name'], 'editor');
    assert.equal(peer['githubId'], 123);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    client?.terminate();
    for (const socket of server.clients) {
      socket.terminate();
    }
    await closed;
    room.document.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

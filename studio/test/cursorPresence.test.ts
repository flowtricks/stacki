import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebSocket, WebSocketServer } from 'ws';
import { createRooms } from '../src/features/collaboration/rooms';
import { record } from '../src/shared/validation';
import { parseCursorState, parseCursorPacket } from '../src/features/collaboration/cursorPresence';
import { PresenceColors, presenceColor } from '../src/features/collaboration/presenceColors';

const file = 'src/pages/index.astro';
const source = '<h1>Unchanged source</h1>';
const state = { page: file, cursor: { x: 0.2, y: 0.4 }, text: 'Live message', typing: true };

test('presence colors are distinct for active collaborators and stable on reconnect', () => {
  const colors = new PresenceColors();
  const first = colors.acquire('alice');
  const second = colors.acquire('bob');
  assert.notEqual(presenceColor({ id: '', color: first }), presenceColor({ id: '', color: second }));
  assert.equal(colors.acquire('alice'), first);
  colors.release('alice');
  colors.release('alice');
  assert.equal(colors.acquire('alice'), first);
});

test('cursor boundaries reject non-finite coordinates, oversized text and invalid anchors', () => {
  for (const cursor of [
    { x: NaN, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: -1 },
  ]) {
    assert.throws(() => parseCursorState({ ...state, cursor }));
  }
  assert.throws(() => parseCursorState({ ...state, text: 'x'.repeat(161) }));
  assert.throws(() =>
    parseCursorState({
      ...state,
      cursor: { x: 0, y: 0, anchor: { path: '"] body', occurrence: 0, x: 0, y: 0 } },
    }),
  );
  assert.throws(() => parseCursorState({ ...state, page: '../private.astro' }));
});

test('cursor updates cross file rooms, keep server identity, coalesce, and never change source', async () => {
  const fixture = await collaboration();
  try {
    const alice = await fixture.connect('alice', file);
    const bob = await fixture.connect('bob', 'src/components/Heading.astro');
    const room = await fixture.rooms.get(file);
    const before = Y.encodeStateAsUpdate(room.document);
    alice.socket.send(JSON.stringify({ type: 'cursor', ...state, id: 'forged', name: 'forged', color: 4000 }));
    const received = parseCursorPacket(await bob.next('cursor'));
    assert.equal(received.name, 'alice');
    assert.notEqual(received.id, 'forged');
    assert.notEqual(received.color, 4000);
    assert.equal(received.text, 'Live message');
    for (let index = 0; index < 100; index++) {
      alice.socket.send(JSON.stringify({ type: 'cursor', ...state, text: String(index) }));
    }
    assert.equal((await bob.next('cursor'))['text'], '99');
    assert.deepEqual(Y.encodeStateAsUpdate(room.document), before);
    assert.equal(await readFile(path.join(fixture.root, file), 'utf8'), source);
    const carol = await fixture.connect('carol', file);
    assert.equal((await carol.next('cursor'))['text'], '99', 'New arrivals receive the latest cursor');
    alice.socket.close();
    assert.equal((await bob.next('cursor'))['cursor'], null, 'Disconnect removes the cursor');
    const reconnected = await fixture.connect('alice', file);
    reconnected.socket.send(JSON.stringify({ type: 'cursor', ...state }));
    assert.equal((await bob.next('cursor'))['color'], received.color);
  } finally {
    await fixture.close();
  }
});

async function collaboration() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cursors-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'src/components'), { recursive: true });
  await writeFile(path.join(root, file), source);
  await writeFile(path.join(root, 'src/components/Heading.astro'), source);
  const rooms = createRooms(root);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  server.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const login = url.searchParams.get('person') ?? 'alice';
    void rooms.get(url.searchParams.get('file') ?? file).then((room) => room.attach(socket, { login, id: login === 'alice' ? 1 : login === 'bob' ? 2 : 3 }));
  });
  return {
    root,
    rooms,
    async connect(person: string, file: string) {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?person=${person}&file=${encodeURIComponent(file)}`);
      const next = inbox(socket);
      await once(socket, 'open');
      await next('sync');
      return { socket, next };
    },
    async close() {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rooms.sockets.close();
      for (const name of [file, 'src/components/Heading.astro']) {
        const room = await rooms.get(name);
        await room.durable.flush();
        room.document.destroy();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
function inbox(socket: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', (bytes) => {
    messages.push(record(JSON.parse(String(bytes))));
    for (const listener of listeners) {
      listener();
    }
  });
  return (type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Missing ${type}`));
      }, 5000);
      const check = () => {
        const index = messages.findIndex((message) => message['type'] === type);
        if (index < 0) {
          return;
        }
        const message = messages.splice(index, 1)[0];
        if (message) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(message);
        }
      };
      listeners.add(check);
      check();
    });
}

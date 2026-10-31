// Goal: reconnect acknowledgments prove disk and durable persistence, not only Yjs convergence.
// Method: fail real filesystem writes, replay the same update over real sockets, then reopen it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as Y from 'yjs';
import { Room } from '../src/features/collaboration/rooms';
import { DraftStorage } from '../src/features/storage/draftStorage';
import { record, string } from '../src/shared/validation';

const file = 'src/pages/index.astro';
const original = '<Section><h1>Preserve this draft</h1></Section>';
const edited = '<Section theme="dark"><h1>Preserve this draft</h1></Section>';

test('accepted edits reach peers before a delayed source write, without acknowledging Saved', async (context) => {
  const state = await fixture();
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let noteWriting = () => {};
  const writing = new Promise<void>((resolve) => {
    noteWriting = resolve;
  });
  const write = filesystem.writeFile;
  const saved: unknown[] = [];
  state.client.on('message', (bytes) => {
    const message = record(JSON.parse(bytes.toString()));
    if (message['type'] === 'saved') {
      saved.push(message);
    }
  });
  context.mock.method(filesystem, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (args[0] === path.join(state.root, file) + '.studio-tmp') {
      noteWriting();
      await waiting;
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const received = response(state.observer, 'update');
    state.client.send(state.update);
    const message = await received;
    assert.equal(message['writePending'], true);
    assert.equal(await readFile(path.join(state.root, file), 'utf8'), original);
    assert.equal(saved.length, 0, 'Delivery does not acknowledge persistence');
    await writing;
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(state.room.document));
    next.getText('source').insert(0, '<!-- next edit -->');
    const second = response(state.observer, 'update');
    state.client.send(
      JSON.stringify({
        type: 'update',
        save: 8,
        epoch: next.getMap('metadata').get('epoch'),
        update: Buffer.from(Y.encodeStateAsUpdate(next)).toString('base64'),
      }),
    );
    next.destroy();
    await second;
    assert.equal(saved.length, 0, 'Later edits also bypass an earlier stalled save');
    const written = response(state.observer, 'source-written');
    const persisted = response(state.client, 'saved');
    release();
    await written;
    await persisted;
    await state.room.durable.flush();
    assert.equal(
      await readFile(path.join(state.root, file), 'utf8'),
      '<!-- next edit -->' + edited,
    );
  } finally {
    release();
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await state.close();
  }
});

for (const failure of ['source', 'durable'] as const) {
  test(`replay repairs a failed ${failure} write before acknowledging Saved`, async () => {
    const state = await fixture();
    const blocked =
      failure === 'source'
        ? path.join(state.root, file + '.studio-tmp')
        : path.join(
            state.root,
            '.stacki/studio/state',
            Buffer.from(file).toString('base64url') + '.bin.tmp',
          );
    try {
      await mkdir(blocked);
      const failed = response(state.client, 'error');
      state.client.send(state.update);
      await failed;
      assert.equal(state.room.text.toString(), edited, 'Yjs merged before persistence failed');
      const bytes = await new DraftStorage(state.root).read(file);
      assert.ok(bytes);
      assert.equal(sourceOf(bytes), original, 'Failed save must not claim durable success');
      await rm(blocked, { recursive: true });
      const reconnected = await state.reconnect();
      const broadcast = failure === 'source' ? response(state.observer, 'update') : undefined;
      const saved = response(reconnected, 'saved');
      reconnected.send(state.update);
      assert.equal((await saved)['save'], 7, 'The acknowledgment identifies the replayed save');
      if (broadcast) {
        const update = string((await broadcast)['update'], 12_000_000);
        assert.equal(sourceOf(Buffer.from(update, 'base64')), edited);
      }
      assert.equal(await readFile(path.join(state.root, file), 'utf8'), edited);
      const recovered = await new DraftStorage(state.root).read(file);
      assert.ok(recovered);
      assert.equal(sourceOf(recovered), edited, 'Duplicate update must retry failed persistence');
      const restarted = new Room(state.root, file);
      await restarted.initialize();
      assert.equal(restarted.text.toString(), edited, 'Resume retains the exact shared draft');
      restarted.document.destroy();
    } finally {
      await state.close();
    }
  });
}

test('a duplicate replay waits for the original in-flight durable batch', async () => {
  const state = await fixture();
  try {
    const updated = response(state.client, 'update');
    state.client.send(state.update);
    await updated;
    const saved = response(state.client, 'saved');
    state.client.send(state.update);
    await saved;
    const bytes = await new DraftStorage(state.root).read(file);
    assert.ok(bytes);
    assert.equal(sourceOf(bytes), edited, 'An in-memory duplicate cannot acknowledge early');
  } finally {
    await state.close();
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-save-recovery-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, file), original);
  const room = new Room(root, file);
  await room.initialize();
  const document = new Y.Doc();
  Y.applyUpdate(document, Y.encodeStateAsUpdate(room.document));
  document.getText('source').insert('<Section'.length, ' theme="dark"');
  const update = JSON.stringify({
    type: 'update',
    save: 7,
    epoch: document.getMap('metadata').get('epoch'),
    update: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
  });
  document.destroy();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => room.attach(socket));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connect = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await response(client, 'sync');
    return client;
  };
  const client = await connect();
  const observer = await connect();
  return {
    root,
    room,
    client,
    observer,
    update,
    async reconnect() {
      client.close();
      await once(client, 'close');
      return connect();
    },
    async close() {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await room.durable.flush();
      room.document.destroy();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function response(client: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', receive);
      reject(new Error(`Missing ${type} response`));
    }, 8000);
    function receive(bytes: RawData) {
      const input: unknown = JSON.parse(bytes.toString());
      const message = record(input);
      if (message['type'] === type) {
        clearTimeout(timer);
        client.off('message', receive);
        resolve(message);
      }
    }
    client.on('message', receive);
  });
}

function sourceOf(bytes: Uint8Array): string {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, bytes);
    return document.getText('source').toString();
  } finally {
    document.destroy();
  }
}

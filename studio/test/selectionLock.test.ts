import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room, checksum } from '../src/features/collaboration/rooms';
import { record } from '../src/shared/validation';
import * as Y from 'yjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-selection-lock-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Heading</h1><p>Paragraph</p>');
  const room = new Room(root, 'src/pages/index.astro');
  await room.initialize();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => room.attach(socket));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const first = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const second = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await Promise.all([once(first, 'open'), once(second, 'open')]);
  return {
    room,
    first,
    second,
    async close() {
      first.terminate();
      second.terminate();
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
    }, 5000);
    function receive(bytes: Buffer) {
      const message = record(JSON.parse(bytes.toString()));
      if (message['type'] === type) {
        clearTimeout(timer);
        client.off('message', receive);
        resolve(message);
      }
    }
    client.on('message', receive);
  });
}

function select(client: WebSocket, selection: string, occurrence = 0) {
  const result = response(client, 'selection');
  client.send(JSON.stringify({ type: 'presence', name: 'Collaborator', selection, occurrence }));
  return result;
}

test('simultaneous selections are shared while editing ownership stays exclusive', async () => {
  const state = await fixture();
  try {
    const results = await Promise.all([
      select(state.first, 'n0', 0),
      select(state.second, 'n0', 1),
    ]);
    assert.equal(results.filter((result) => result['selection'] === 'n0').length, 2);
    assert.equal(results.filter((result) => result['owner']).length, 1);
    assert.equal([...state.room.clients.values()].filter((peer) => peer.editing).length, 1);
    const owner = !results[0]?.['owner'] ? state.first : state.second;
    const other = owner === state.first ? state.second : state.first;
    assert.equal((await select(other, 'n1'))['selection'], 'n1');
    const inspected = await select(other, 'n0');
    assert.equal(inspected['selection'], 'n0', 'Inspection selects the requested element');
    assert.ok(inspected['owner']);
    await select(owner, '');
    assert.equal(
      [...state.room.clients.values()].find((peer) => peer.selection === 'n0')?.editing,
      true,
    );
    assert.equal((await select(other, 'n0'))['selection'], 'n0');
  } finally {
    await state.close();
  }
});

test('disconnect releases the lock and a non-owner cannot delete the selected element', async () => {
  const state = await fixture();
  try {
    await select(state.first, 'n0');
    const rejected = response(state.second, 'error');
    const source = state.room.text.toString();
    state.second.send(
      JSON.stringify({
        type: 'action',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        checksum: checksum(source),
        action: { kind: 'delete', node: 'n0' },
      }),
    );
    assert.match(String((await rejected)['message']), /is editing this element/);
    assert.equal(state.room.text.toString(), source);
    const released = response(state.second, 'presence');
    state.first.close();
    await released;
    assert.equal((await select(state.second, 'n0'))['selection'], 'n0');
  } finally {
    await state.close();
  }
});

test('takeover transfers editing ownership and preserves both selections', async () => {
  const state = await fixture();
  try {
    await select(state.first, 'n0');
    await select(state.second, 'n1');
    const denied = await select(state.second, 'n0');
    const owner = record(denied['owner']);
    assert.equal(denied['requested'], 'n0');
    const evicted = response(state.first, 'selection');
    const accepted = response(state.second, 'selection');
    const request = { type: 'take-selection', owner: owner['id'], selection: 'n0', occurrence: 2 };
    state.second.send(JSON.stringify(request));
    assert.equal((await accepted)['selection'], 'n0');
    const notice = await evicted;
    assert.equal(notice['selection'], 'n0');
    assert.equal(notice['occurrence'], 0);
    const peers = [...state.room.clients.values()];
    assert.equal(peers.filter((peer) => peer.selection === 'n0').length, 2);
    assert.equal(peers.filter((peer) => peer.editing).length, 1);
    assert.equal(peers.find((peer) => peer.editing)?.occurrence, 2);
    assert.equal((await select(state.first, 'n0'))['selection'], 'n0');
    await select(state.second, 'n1');
    await select(state.first, 'n1');
    const stale = response(state.second, 'error');
    state.second.send(JSON.stringify(request));
    assert.match(String((await stale)['message']), /selection has changed/);
    assert.equal(
      [...state.room.clients.values()].filter((peer) => peer.selection === 'n1').length,
      2,
    );
    assert.equal(state.room.text.toString(), '<h1>Heading</h1><p>Paragraph</p>');
  } finally {
    await state.close();
  }
});

test('inspection permits child insertion but refuses settings updates until takeover', async () => {
  const state = await fixture();
  const local = new Y.Doc();
  try {
    await select(state.first, 'n0');
    await select(state.second, 'n0');
    const before = state.room.text.toString();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(state.room.document));
    local.getText('source').insert(3, 'Changed ');
    const rejected = response(state.second, 'error');
    state.second.send(
      JSON.stringify({
        type: 'update',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        update: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64'),
      }),
    );
    assert.match(String((await rejected)['message']), /Take over to edit its settings/);
    assert.equal(state.room.text.toString(), before);
    const inserted = response(state.second, 'saved');
    state.second.send(
      JSON.stringify({
        type: 'action',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        checksum: checksum(before),
        action: {
          kind: 'insert-content',
          target: 'n0',
          placement: 'inside',
          content: { type: 'element', tag: 'span' },
        },
      }),
    );
    await inserted;
    assert.match(state.room.text.toString(), /<h1>Heading\s*<span>/);
    const peers = [...state.room.clients.values()];
    assert.equal(peers[0]?.selection, 'n0', 'The first editor keeps the parent selected');
    assert.equal(peers[1]?.selection, 'n0.1', 'The inserting editor selects the new span');
    assert.equal(peers.filter((peer) => peer.editing).length, 2);
  } finally {
    local.destroy();
    await state.close();
  }
});

test('reopening an unchanged page acknowledges sync without rewriting source or broadcasting edits', async () => {
  const state = await fixture();
  try {
    const file = path.join(state.room.root, state.room.file);
    const before = await stat(file);
    let updates = 0;
    state.first.on('message', (bytes: Buffer) => {
      if (record(JSON.parse(bytes.toString()))['type'] === 'update') {
        updates++;
      }
    });
    const saved = response(state.second, 'saved');
    state.second.send(
      JSON.stringify({
        type: 'update',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        update: Buffer.from(Y.encodeStateAsUpdate(state.room.document)).toString('base64'),
      }),
    );
    await saved;
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    assert.equal(updates, 0);
  } finally {
    await state.close();
  }
});

test('structural acknowledgements select the clone and keep another editor on the same paragraph', async () => {
  const state = await fixture();
  try {
    await select(state.first, 'n0');
    await select(state.second, 'n1');
    const firstUpdate = response(state.first, 'update');
    const secondUpdate = response(state.second, 'update');
    const saved = response(state.first, 'saved');
    state.first.send(
      JSON.stringify({
        type: 'action',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        checksum: checksum(state.room.text.toString()),
        action: { kind: 'duplicate', node: 'n0' },
      }),
    );
    const own = await firstUpdate;
    const peer = await secondUpdate;
    assert.equal(own['selection'], 'n1');
    assert.equal(peer['selection'], 'n2');
    assert.equal(own['structural'], true, 'The initiator requests an immediate full render');
    assert.equal(peer['structural'], true, 'Collaborators receive the same render priority');
    await saved;
    const deleted = response(state.first, 'update');
    state.first.send(
      JSON.stringify({
        type: 'action',
        epoch: state.room.document.getMap('metadata').get('epoch'),
        checksum: checksum(state.room.text.toString()),
        action: { kind: 'delete', node: 'n1' },
      }),
    );
    assert.equal((await deleted)['selection'], 'n1');
    await response(state.first, 'saved');
    const peers = [...state.room.clients.values()];
    assert.equal(peers[0]?.selection, 'n1');
    assert.equal(peers[1]?.selection, 'n1');
    assert.equal(peers[0]?.editing, false, 'Deletion fallback respects another editor’s ownership');
    assert.equal(peers[1]?.editing, true);
  } finally {
    await state.close();
  }
});

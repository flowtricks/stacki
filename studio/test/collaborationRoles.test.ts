// Goal: edits sent over the collaboration socket answer to project roles on the
// server, exactly as the HTTP write routes do, whatever the browser checked first.
// A client edits only inside a page's layout and never component source; a person
// named in no role gets the file's default role; an admin edits anything; presence
// and resynchronization stay open to every role.
// Method: run real rooms behind a WebSocket server over a temporary project with
// `.stacki/roles.json`, attach each connection with `connectionRole` from the
// upgrade request's `x-studio-user` header (STUDIO_CONTAINER_TOKEN set, as behind
// the worker), send raw `update` and `action` messages as a client that skipped its
// own checks would, and check the refusal message and the room's text. The
// file-to-feature table and the local, unsigned-in fallback are checked directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { Room, checksum } from '../src/features/collaboration/rooms';
import { connectionRole } from '../src/features/roles/serverAccess';
import { documentFeatures } from '../src/features/roles/documentAccess';
import { record } from '../src/shared/validation';

const PAGE = 'src/pages/index.astro';
const COMPONENT = 'src/components/Card.astro';
const PAGE_SOURCE = `---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout><h1>Inside</h1></Layout>\n`;
const COMPONENT_SOURCE = '<article class="card"><slot /></article>\n';
const ROLES = {
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['Owner'] },
    { id: 'client', name: 'Client', members: ['acme'] },
  ],
};

async function studio() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-socket-roles-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'src/components'), { recursive: true });
  await mkdir(path.join(root, '.stacki'));
  await writeFile(path.join(root, PAGE), PAGE_SOURCE);
  await writeFile(path.join(root, COMPONENT), COMPONENT_SOURCE);
  await writeFile(path.join(root, '.stacki/roles.json'), JSON.stringify(ROLES));
  const rooms = new Map<string, Room>();
  for (const file of [PAGE, COMPONENT]) {
    const room = new Room(root, file);
    await room.initialize();
    rooms.set(file, room);
  }
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket, request: IncomingMessage) => {
    const room = rooms.get(new URL(request.url ?? '/', 'http://studio').searchParams.get('file') ?? '');
    assert.ok(room, 'The test connects only to open rooms');
    room.attach(socket, undefined, undefined, undefined, connectionRole(root, request));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = [];
  return {
    room: (file: string) => {
      const room = rooms.get(file);
      assert.ok(room, file);
      return room;
    },
    connect: async (login: string, file: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/studio/sync?file=${encodeURIComponent(file)}`, { headers: { 'x-studio-user': login } });
      sockets.push(socket);
      const synced = response(socket, 'sync');
      await once(socket, 'open');
      await synced;
      return socket;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const room of rooms.values()) {
        await room.durable.flush();
        room.document.destroy();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function response(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error(`Missing ${type} response`));
    }, 5000);
    function receive(bytes: Buffer) {
      const message = record(JSON.parse(bytes.toString()));
      if (message['type'] === type) {
        clearTimeout(timer);
        socket.off('message', receive);
        resolve(message);
      }
    }
    socket.on('message', receive);
  });
}

/** Sends the CRDT update that turns the room's text into `edit(text)`, as a browser would. */
function sendTextEdit(socket: WebSocket, room: Room, edit: (text: Y.Text) => void) {
  const local = new Y.Doc();
  try {
    Y.applyUpdate(local, Y.encodeStateAsUpdate(room.document));
    edit(local.getText('source'));
    socket.send(
      JSON.stringify({
        type: 'update',
        epoch: room.document.getMap('metadata').get('epoch'),
        update: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64'),
      }),
    );
  } finally {
    local.destroy();
  }
}

/** The reply to the next edit: `saved` when the room took it, `error` when it refused. */
async function reply(socket: WebSocket) {
  return Promise.race([response(socket, 'saved'), response(socket, 'error')]);
}

test('a client is refused edits outside the layout and to component source; inside the layout is kept', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const state = await studio();
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await state.close();
  });
  const page = state.room(PAGE);
  const client = await state.connect('acme', PAGE);
  const before = page.text.toString();
  let answer = reply(client);
  sendTextEdit(client, page, (text) => text.insert(before.indexOf('<Layout>'), '<p>Outside</p>'));
  assert.match(String((await answer)['message']), /Client mode cannot change the page layout/);
  assert.equal(page.text.toString(), before, 'the refused edit never reached the room');
  answer = reply(client);
  client.send(
    JSON.stringify({
      type: 'action',
      epoch: page.document.getMap('metadata').get('epoch'),
      checksum: checksum(before),
      action: { kind: 'delete', node: 'layout' },
    }),
  );
  assert.match(String((await answer)['message']), /layout/);
  assert.equal(page.text.toString(), before);
  answer = reply(client);
  sendTextEdit(client, page, (text) => text.insert(before.indexOf('Inside') + 'Inside'.length, ' text'));
  assert.equal((await answer)['type'], 'saved', 'text inside the layout is Client mode’s own edit');
  assert.match(page.text.toString(), /<h1>Inside text<\/h1>/);

  const component = state.room(COMPONENT);
  const onComponent = await state.connect('ACME', COMPONENT);
  answer = reply(onComponent);
  sendTextEdit(onComponent, component, (text) => text.insert(0, '<!-- x -->'));
  assert.match(String((await answer)['message']), /Your role \(Client\) cannot do this in this project/);
  assert.equal(component.text.toString(), COMPONENT_SOURCE);
  // Presence and resynchronization change nothing, so every role keeps them.
  const selected = response(onComponent, 'selection');
  onComponent.send(JSON.stringify({ type: 'presence', name: 'Client', selection: 'n0' }));
  assert.equal((await selected)['selection'], 'n0');
  const synced = response(onComponent, 'sync');
  onComponent.send(JSON.stringify({ type: 'sync-request' }));
  assert.equal(typeof (await synced)['update'], 'string');
});

test('a person named in no role edits as the default role; an admin edits anything', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const state = await studio();
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await state.close();
  });
  const component = state.room(COMPONENT);
  const stranger = await state.connect('stranger', COMPONENT);
  let answer = reply(stranger);
  sendTextEdit(stranger, component, (text) => text.insert(0, '<!-- x -->'));
  assert.match(String((await answer)['message']), /Your role \(Client\) cannot do this/, 'the file’s default role is client');
  assert.equal(component.text.toString(), COMPONENT_SOURCE);

  const owner = await state.connect('owner', COMPONENT);
  answer = reply(owner);
  sendTextEdit(owner, component, (text) => text.insert(0, '<!-- admin -->'));
  assert.equal((await answer)['type'], 'saved');
  assert.match(component.text.toString(), /^<!-- admin -->/);
  const page = state.room(PAGE);
  const onPage = await state.connect('Owner', PAGE);
  answer = reply(onPage);
  sendTextEdit(onPage, page, (text) => text.insert(page.text.toString().indexOf('<Layout>'), '<p>Outside</p>'));
  assert.equal((await answer)['type'], 'saved', 'admin edits outside the layout');
  assert.match(page.text.toString(), /<p>Outside<\/p><Layout>/);
});

test('a local Studio without sign-in edits as admin, and each document names the HTTP route’s features', async () => {
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  assert.equal((await connectionRole('/site', { headers: {} })()).isAdmin, true);
  assert.equal(documentFeatures(PAGE), undefined, 'pages are open; Client mode is checked per edit');
  assert.deepEqual(documentFeatures(COMPONENT), ['component:edit']);
  assert.deepEqual(documentFeatures('.stacki/canvas/0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d.astro'), ['component:edit']);
  assert.deepEqual(documentFeatures('.stacki/roles.json'), ['settings:roles']);
  assert.equal(documentFeatures('.stacki/guide.json'), undefined);
  assert.deepEqual(documentFeatures('src/styles/global.css'), ['panel:style', 'panel:selectors', 'code:edit']);
  assert.deepEqual(documentFeatures('src/content/blog/post.md'), ['panel:cms', 'code:edit']);
  assert.deepEqual(documentFeatures('src/lib/site.ts'), ['code:edit']);
  assert.throws(() => documentFeatures(''), /A document names a file/);
});

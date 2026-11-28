// Goal: nothing the editor does for a role without code permission is refused for the developer's code it moves
// around: undoing a delete made in the Navigator, cutting from one page and pasting into another, and pasting any
// part of one page into another, however the paste re-indents it.
// Method: drive real rooms over one workspace as the built-in Client. Delete and paste with the editor's own actions,
// and undo as the browser does, with a text update back to the earlier source. Pages hold calls to the developer's own
// functions, which no role without code permission could write afresh.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { checksum, createRooms, Room } from '../src/features/collaboration/rooms';
import { SerialQueue } from '../src/shared/serialQueue';
import { CodeGuard } from '../src/features/roles/codeGuard';
import { applyEdits, flatten, nodesOf } from '../src/features/source/source';
import { pasteEdits } from '../src/features/source/paste';
import { frontmatterRange } from '../src/features/source/frontmatter';
import { record } from '../src/shared/validation';
import { DEFAULT_PROJECT_ROLES, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const CLIENT = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');
const FIRST = 'src/pages/index.astro';
const SECOND = 'src/pages/blog/second.astro';
const FIRST_SOURCE = `---
import Layout from '../layouts/Layout.astro';
import Card from '../components/Card.astro';
import { formatName, formatDate, load } from '../lib/format';
const items = await load('items');
const today = formatDate(new Date(), {
  month: 'long',
});
---

<Layout>
  <section class="a">
    <h2>{formatName(today)}</h2>
    {formatName(items)
      .filter((item) => item.shown)
      .map((item) => (
        <p title={formatName(item.title)}>{formatDate(item.date)}</p>
      ))}
    <Card label={formatName('x')} {...load('card')} />
    {items.length > 0 && <b>{formatName(items[0])}</b>}
  </section>
  <p class="plain">Words</p>
</Layout>
`;
const SECOND_SOURCE = `---
import Layout from '../../layouts/Layout.astro';
---

<Layout>
  <div>
    <div class="deep">
      <p>Target</p>
    </div>
  </div>
</Layout>
`;

async function workspace(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-actions-'));
  for (const [file, source] of [
    [FIRST, FIRST_SOURCE],
    [SECOND, SECOND_SOURCE],
  ] as const) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  const rooms = createRooms(root);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket, request) => {
    const file = new URL(request.url ?? '/', 'http://studio').searchParams.get('file') ?? '';
    void rooms.get(file).then((room) => {
      room.attach(socket, undefined, undefined, undefined, () => Promise.resolve(CLIENT));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = [];
  context.after(async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    await rooms.persist();
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (file: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?file=${encodeURIComponent(file)}`);
    sockets.push(socket);
    const room = await rooms.get(file);
    await reply(socket, ['sync']);
    return { socket, room };
  };
  return { root, rooms, connect };
}

function reply(socket: WebSocket, types: readonly string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${types.join('/')}`)), 20_000);
    const receive = (bytes: Buffer) => {
      const message = record(JSON.parse(bytes.toString()));
      if (types.includes(String(message['type']))) {
        clearTimeout(timer);
        socket.off('message', receive);
        resolve(message);
      }
    };
    socket.on('message', receive);
  });
}

interface Open {
  readonly socket: WebSocket;
  readonly room: Room;
}

async function send(open: Open, message: Record<string, unknown>) {
  const answer = reply(open.socket, ['saved', 'error']);
  open.socket.send(JSON.stringify({ epoch: open.room.document.getMap('metadata').get('epoch'), ...message }));
  const value = await answer;
  return value['type'] === 'saved' ? 'saved' : String(value['message']);
}
const act = (open: Open, action: unknown) => send(open, { type: 'action', checksum: checksum(open.room.text.toString()), action });

/** The browser's undo and redo: a text update that takes the page to `source`. */
function restore(open: Open, source: string) {
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(open.room.document));
  const vector = Y.encodeStateVector(local);
  const text = local.getText('source');
  local.transact(() => {
    text.delete(0, text.length);
    text.insert(0, source);
  });
  const update = Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64');
  local.destroy();
  return send(open, { type: 'update', update });
}

const nodes = (source: string) => flatten(nodesOf(source)).filter((node) => node.start !== undefined && node.end !== undefined);
const find = (source: string, name: string) => {
  const found = nodes(source).find((node) => node.name === name);
  assert.ok(found?.id !== undefined, name);
  return found;
};

test('undo brings back what a Navigator delete removed, developer code included', async (context) => {
  const { connect } = await workspace(context);
  const first = await connect(FIRST);
  const before = first.room.text.toString();
  assert.equal(await act(first, { kind: 'delete', node: find(before, 'section').id }), 'saved');
  const deleted = first.room.text.toString();
  assert.ok(!deleted.includes('formatDate(item.date)'));
  assert.equal(await restore(first, before), 'saved');
  assert.equal(await restore(first, deleted), 'saved', 'redo');
  assert.equal(await restore(first, before), 'saved', 'undo again');
});

test('what is cut from one page pastes into another', async (context) => {
  const { connect, rooms } = await workspace(context);
  const first = await connect(FIRST);
  const before = first.room.text.toString();
  const section = find(before, 'section');
  const clipboard = { file: FIRST, fragment: before.slice(section.start, section.end), frontmatter: frontmatterRange(before)?.value ?? '' };
  assert.equal(await act(first, { kind: 'delete', node: section.id }), 'saved');
  await rooms.persist();
  const second = await connect(SECOND);
  const target = nodes(second.room.text.toString()).find((node) => node.name === 'p');
  assert.ok(target?.id !== undefined);
  assert.equal(await act(second, { kind: 'paste', target: target.id, placement: 'after', clipboard }), 'saved');
  assert.ok(second.room.text.toString().includes('formatDate(item.date)'));
});

test('every part of a page pastes into another page, and into a new depth of its own', async (context) => {
  const { root } = await workspace(context);
  const guard = new CodeGuard(root);
  const frontmatter = frontmatterRange(FIRST_SOURCE)?.value ?? '';
  const parts = nodes(FIRST_SOURCE).filter((node) => node.name !== 'Layout' && node.kind !== 'text');
  assert.ok(parts.length >= 8, String(parts.length));
  let checked = 0;
  for (const [file, page] of [
    [SECOND, SECOND_SOURCE],
    [FIRST, FIRST_SOURCE],
  ] as const) {
    // Places the editor can paste into or after: a heading and the last paragraph; in the other page, both depths.
    const targets = [nodes(page).find((node) => node.name === (file === FIRST ? 'h2' : 'div')), nodes(page).findLast((node) => node.name === 'p')].flatMap(
      (node) => (node === undefined ? [] : [node]),
    );
    for (const part of parts) {
      const fragment = FIRST_SOURCE.slice(part.start, part.end);
      for (const target of targets.slice(0, 2)) {
        assert.ok(target.id !== undefined);
        const action = { kind: 'paste', target: target.id, placement: 'after', clipboard: { file: FIRST, fragment, frontmatter } } as const;
        let after: string;
        try {
          after = applyEdits(page, pasteEdits(page, file, action));
        } catch {
          // The paste itself is not possible here (a branch of a condition on its own); nothing to check.
          continue;
        }
        checked++;
        await guard.assertAllowed(CLIENT, { file, before: page, after }).catch((error: unknown) => {
          assert.fail(`${String(error)}\n${fragment}\n---\n${after}`);
        });
      }
    }
  }
  assert.ok(checked >= parts.length * 2, `${checked} pastes of ${parts.length} parts`);
});

test('an AI change that keeps the page’s own code is applied, and one that adds code is not', async (context) => {
  const { root } = await workspace(context);
  const guard = new CodeGuard(root);
  const kept = FIRST_SOURCE.replace('<p class="plain">Words</p>', '<h3 class="intro">New words</h3>\n  <p class="plain">More words</p>');
  await guard.assertAllowed(CLIENT, { file: FIRST, before: FIRST_SOURCE, after: kept });
  await guard.assertAllowed(CLIENT, { file: 'src/pages/copy.astro', before: undefined, after: kept });
  const added = FIRST_SOURCE.replace('Words</p>', '{load("secrets")}</p>');
  await assert.rejects(guard.assertAllowed(CLIENT, { file: FIRST, before: FIRST_SOURCE, after: added }), /cannot add or change code/);
});

// Edits sent without waiting for each answer, as fast typing over a slow check does.
async function burst(open: Open, steps: readonly ((source: string) => string)[]) {
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(open.room.document));
  const text = local.getText('source');
  const messages = steps.map((step, index) => {
    const vector = Y.encodeStateVector(local);
    const next = step(text.toString());
    const old = text.toString();
    let start = 0;
    while (start < old.length && old[start] === next[start]) {
      start++;
    }
    let end = 0;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) {
      end++;
    }
    local.transact(() => {
      text.delete(start, old.length - start - end);
      text.insert(start, next.slice(start, next.length - end));
    });
    const update = Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64');
    return { type: 'update', save: index + 1, update, epoch: open.room.document.getMap('metadata').get('epoch') };
  });
  local.destroy();
  const saved = new Set<number>();
  let errors = 0;
  const seen: string[] = [];
  const watch = () => seen.push(open.room.text.toString());
  open.room.document.on('update', watch);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Unanswered: ${saved.size} saved, ${errors} refused`)), 30_000);
    open.socket.on('message', (bytes: Buffer) => {
      const message = record(JSON.parse(bytes.toString()));
      if (message['type'] === 'saved') {
        saved.add(Number(message['save']));
      } else if (message['type'] === 'error') {
        errors++;
      }
      if (saved.size + errors === steps.length) {
        clearTimeout(timer);
        resolve();
      }
    });
    for (const message of messages) {
      open.socket.send(JSON.stringify(message));
    }
  });
  open.room.document.off('update', watch);
  return { saved: saved.size, errors, seen };
}

const type = (word: string) => (source: string) => source.replace('</p>\n</Layout>', `${word}</p>\n</Layout>`);

test('edits that pile up are saved one acknowledgement each, as one checked change', async (context) => {
  const { connect } = await workspace(context);
  const first = await connect(FIRST);
  const result = await burst(
    first,
    Array.from({ length: 60 }, () => type('a')),
  );
  assert.deepEqual([result.saved, result.errors], [60, 0]);
  assert.ok(first.room.text.toString().includes(`Words${'a'.repeat(60)}</p>`));
  assert.ok(result.seen.length < 60, 'Waiting edits were taken together');
});

test('a refused edit among waiting ones is refused as it is alone, and never reaches the document', async (context) => {
  const { connect } = await workspace(context);
  const first = await connect(FIRST);
  const steps = [type('a'), type('b'), type('{process.env.X}'), type('c'), type('d')];
  const result = await burst(first, steps);
  // The first two stand; the code is refused, and what was typed on top of it waits for it, one at a time or together.
  assert.deepEqual([result.saved, result.errors], [2, 3]);
  assert.ok(result.seen.every((source) => !source.includes('process.env')));
  assert.ok(first.room.text.toString().includes('Wordsba</p>') || first.room.text.toString().includes('Wordsab</p>'));
});

test('code added and removed again while edits wait is never applied on the way', async (context) => {
  const { connect } = await workspace(context);
  const first = await connect(FIRST);
  const steps = [type('a'), type('{process.env.X}'), (source: string) => source.replace('{process.env.X}', ''), type('b')];
  const result = await burst(first, steps);
  assert.ok(
    result.seen.every((source) => !source.includes('process.env')),
    result.seen.join('\n'),
  );
  assert.ok(!first.room.text.toString().includes('process.env'));
});

test('a shared page holds nothing but the text the checks read', async (context) => {
  const { connect } = await workspace(context);
  const second = await connect(SECOND);
  const before = second.room.text.toString();
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(second.room.document));
  const vector = Y.encodeStateVector(local);
  local.getText('source').insertEmbed(0, { extra: true });
  const update = Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64');
  local.destroy();
  assert.notEqual(await send(second, { type: 'update', update }), 'saved');
  assert.equal(second.room.text.length, before.length);
});

test('edits still run after the project queue refused a backlog', async (context) => {
  const { root } = await workspace(context);
  let refusing = false;
  const coordinator = new SerialQueue(async () => {
    if (refusing) {
      throw new Error('Busy');
    }
  });
  const room = new Room(root, SECOND, coordinator);
  await room.initialize();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => room.attach(socket, undefined, undefined, undefined, () => Promise.resolve(CLIENT)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/`);
  context.after(async () => {
    socket.terminate();
    server.close();
    await room.persist();
  });
  await reply(socket, ['sync']);
  const epoch = room.document.getMap('metadata').get('epoch');
  const nothing = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64');
  refusing = true;
  const errors: string[] = [];
  const both = new Promise<void>((resolve) => {
    socket.on('message', (bytes: Buffer) => {
      const message = record(JSON.parse(bytes.toString()));
      if (message['type'] === 'error' && errors.push(String(message['message'])) === 3) {
        resolve();
      }
    });
  });
  for (let sent = 0; sent < 3; sent++) {
    socket.send(JSON.stringify({ type: 'update', epoch, update: nothing }));
  }
  await both;
  refusing = false;
  assert.equal(await restore({ socket, room }, room.text.toString().replace('Target', 'Changed')), 'saved');
});

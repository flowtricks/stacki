// Goal: a fast style drag in Studio (and the demo, which answers the same route)
// never reports "Another editor changed this file" / "This file changed" for its
// own edits, and costs a bounded number of writes, while a real edit by someone
// else still trips the guard. The clip-path editor once produced that toast on
// every quick handle drag: each tick wrote with the version the panel last saw as
// its base, so the second write in flight carried the original text and the
// server's version check refused it.
// Method: the panel's real writer (writeEmbedDocument over Studio's style
// transport) against a real room behind the server's own saveSource, over HTTP.
// A burst of live writes is fired without awaiting, the way pointer moves arrive;
// the POSTs are counted, every result is checked, and the room must end on the
// last value. Then the room is changed behind the panel's back and the next
// write must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRooms } from '../src/features/collaboration/rooms';
import { saveSource } from '../src/features/settings/styleRoutes';
import { loadEmbedDocs, writeEmbedDocument, type EmbedSource } from '../vendor/stacki/src/features/style/model/webflow';

const FILE = 'src/styles/global.css';
const INITIAL = '.section.hero { clip-path: inset(0% round 0%); }';
const TICKS = 40;

test('a burst of live drag writes lands as a bounded number of writes with no conflict, and an outside edit still conflicts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-style-drag-'));
  await mkdir(path.join(root, 'src/styles'), { recursive: true });
  await writeFile(path.join(root, FILE), INITIAL);
  const rooms = createRooms(root);
  const room = await rooms.get(FILE);
  let posts = 0;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let result: unknown;
        if (request.method === 'GET') {
          result = { source: room.text.toString() };
        } else {
          posts += 1;
          result = await saveSource(request, rooms, async () => {
            let body = '';
            for await (const chunk of request) {
              body += String(chunk);
            }
            return body;
          });
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fetchOriginal = globalThis.fetch;
  const windowOriginal = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.fetch = (input, options) => fetchOriginal(new URL(String(input), `http://127.0.0.1:${address.port}`), options);
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  try {
    const source: EmbedSource = {
      key: FILE,
      label: 'global.css',
      classNames: [],
      fromComponent: false,
      componentName: undefined,
      order: 0,
      element: undefined,
      origin: { kind: 'file', path: FILE },
    };
    const { docs, errors } = await loadEmbedDocs([source]);
    assert.deepEqual(errors, []);
    const embedDocument = docs[0];
    assert.ok(embedDocument);
    const declaration = embedDocument.regions[0]?.root?.first;
    assert.ok(declaration?.type === 'rule');
    const clip = declaration.first;
    assert.ok(clip?.type === 'decl');

    // Pointer moves: mutate, write, never wait — as onLiveSetProps does.
    const results = [];
    for (let tick = 1; tick <= TICKS; tick += 1) {
      clip.value = `inset(${(tick * 0.18).toFixed(2)}% round 24% 9%)`;
      results.push(writeEmbedDocument(embedDocument, true));
    }
    const settled = await Promise.all(results);
    for (const result of settled) {
      assert.equal(result.ok, true, result.ok ? '' : result.error);
    }
    // One write in flight, one waiting that carries every later tick.
    assert.ok(posts <= 2, `expected at most 2 writes for ${TICKS} ticks, saw ${posts}`);
    assert.equal(room.text.toString(), `.section.hero { clip-path: inset(${(TICKS * 0.18).toFixed(2)}% round 24% 9%); }`);
    assert.equal(embedDocument.code, room.text.toString());

    // The release commit after the burst is our own edit too.
    clip.value = 'inset(7.2% round 24% 9%)';
    const commit = await writeEmbedDocument(embedDocument);
    assert.equal(commit.ok, true);
    assert.equal(room.text.toString(), '.section.hero { clip-path: inset(7.2% round 24% 9%); }');

    // Someone else edits the file: the next write is refused, and the file keeps their edit.
    await room.setSource('.section.hero { clip-path: none; }');
    clip.value = 'inset(9% round 24% 9%)';
    const stale = await writeEmbedDocument(embedDocument, true);
    assert.equal(stale.ok, false);
    assert.match(stale.ok ? '' : stale.error, /Another editor changed this file/);
    assert.equal(room.text.toString(), '.section.hero { clip-path: none; }');
  } finally {
    globalThis.fetch = fetchOriginal;
    if (windowOriginal) {
      Object.defineProperty(globalThis, 'window', windowOriginal);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    server.close();
    await once(server, 'close');
    room.document.destroy();
    rooms.sockets.close();
    await rm(root, { recursive: true, force: true });
  }
});

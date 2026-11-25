import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRooms } from '../src/features/collaboration/rooms';
import { saveSource } from '../src/features/settings/styleRoutes';
import { styleTransport } from '../src/features/settings/styleTransport';
import { record, string } from '../src/shared/validation';

// Real room commits over HTTP: a newer scan must never make an older panel's
// edit appear current and overwrite a collaborator's change.
test('style writes keep the originating source version despite background reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-style-writes-'));
  const file = 'src/styles/global.css';
  await mkdir(path.join(root, 'src/styles'), { recursive: true });
  await writeFile(path.join(root, file), '.one { color: red; }');
  const rooms = createRooms(root);
  const room = await rooms.get(file);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let result: unknown;
        if (request.method === 'GET') {
          result = { source: room.text.toString() };
        } else {
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
    const before = string(record(await styleTransport.readStyleFile(file))['css']);
    await room.setSource('.one { color: green; }');
    await styleTransport.readStyleFile(file);
    await assert.rejects(styleTransport.writeStyleFile({ filePath: file, css: '.one { color: blue; }', base: before }), /Another editor changed/);
    assert.equal(room.text.toString(), '.one { color: green; }');
    await styleTransport.writeStyleFile({
      filePath: file,
      css: '.one { color: blue; }',
      base: room.text.toString(),
    });
    assert.equal(room.text.toString(), '.one { color: blue; }');
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

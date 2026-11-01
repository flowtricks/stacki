import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createRooms } from '../src/features/collaboration/rooms';
import { cmsRoutes } from '../src/features/cms/cmsServer';
import { record } from '../src/shared/validation';

export async function cmsFixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cms-test-'));
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  const rooms = createRooms(root);
  const route = cmsRoutes(root, rooms);
  const server = createServer((req, res) => {
    void route(req, res, '/studio/api/cms', async () => {
      let body = '';
      for await (const bytes of req) {
        body += String(bytes);
      }
      return body;
    }).catch((error: unknown) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    root,
    rooms,
    post: async (operation: string, payload: unknown, versions: unknown = {}, expectedData?: unknown) =>
      record(
        await (
          await fetch(`http://127.0.0.1:${address.port}`, {
            method: 'POST',
            body: JSON.stringify({
              operation,
              payload,
              versions,
              ...(expectedData === undefined ? {} : { expectedData }),
            }),
          })
        ).json(),
      ),
    close: async () => {
      server.close();
      server.closeAllConnections();
      rooms.sockets.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

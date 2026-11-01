import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createRooms } from '../src/features/collaboration/rooms';
import { propertyRoutes } from '../src/features/componentProperties/propertyServer';
import { record } from '../src/shared/validation';
import { parseComponentProperties, parsePropertiesResult } from '../vendor/stacki/shared/properties/propertyEditing';

export const component = 'src/components/Card.astro';
export const consumer = 'src/pages/index.astro';
export const source = `---\ninterface Props {\n  /** Title 🌱 */\n  title?: string;\n  tone?: 'light' | 'dark';\n}\nconst { title = 'Hello', tone = 'light' } = Astro.props;\n---\n<h2 data-tone={tone}>{title}</h2>\n<style>h2 { color: red; }</style>\n`;
export const instance = `---\nimport Tile from '@/components/Card.astro';\n---\n<Tile title="Welcome" tone="light" />\n`;
export async function propertyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-properties-'));
  await mkdir(path.join(root, 'src/components'), { recursive: true });
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, component), source);
  await writeFile(path.join(root, consumer), instance);
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  const rooms = createRooms(root);
  const route = propertyRoutes(root, rooms);
  const server = createServer((req, res) => {
    void route(req, res, '/studio/api/component-properties', async () => {
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
  const url = `http://127.0.0.1:${address.port}/studio/api/component-properties`;
  return {
    root,
    rooms,
    get: async () => {
      const result = parsePropertiesResult(await (await fetch(url + '?file=' + component)).json(), parseComponentProperties);
      assert.ok(result.ok);
      return result.value;
    },
    post: async (body: unknown) => record(await (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).json()),
    close: async () => {
      server.close();
      server.closeAllConnections();
      rooms.sockets.close();
      for (const file of [component, consumer]) {
        const room = await rooms.get(file);
        await room.durable.flush();
        room.document.destroy();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

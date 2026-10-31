// Goal: verify shared publishing UI against real drafts, metadata writes and linked-project reads.
// Method: serve temporary projects and real WebSocket rooms; remote providers are not contacted.
import { linkedPublishProject } from '../vendor/stacki/electron/project/publishLinkedProject';
import { parseDiscoveryRequest } from '../vendor/stacki/shared/properties/publishDiscovery';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { git, setToolPathHome } from '../vendor/stacki/electron/lib/nodeTools';
import {
  repositoryState,
  connectPublishingRepository,
} from '../vendor/stacki/electron/project/publishRepositories';
import { parseRepositoryRequest } from '../vendor/stacki/shared/ipc/publishRepository';
import path from 'node:path';
import { build } from 'esbuild';
import { browserBoundary } from '../scripts/browserBoundary';
import type { Room } from '../src/features/collaboration/rooms';
import { createRooms } from '../src/features/collaboration/rooms';
import { Publisher, runBuild } from '../src/features/publishing/publish';
import { publishRoute } from '../src/features/publishing/publishRoutes';
import { metadataRoute } from '../src/features/settings/projectMetadata';
import { RepositorySync } from '../src/features/github/sync';
import { automaticSync } from '../src/features/github/automaticSync';
import type { IncomingChanges, RepositoryAccess } from '../src/features/github/github';

export async function sharedPublishingFixture() {
  setToolPathHome(homedir());
  const root = await prepareProject();
  const rooms = createRooms(root);
  const opened = await Promise.all(
    ['index', 'other'].map((name) => rooms.get(`src/pages/${name}.astro`)),
  );
  let incoming: IncomingChanges = { sha: 'a'.repeat(40), files: [] };
  let checks = 0;
  const repository: RepositoryAccess = {
    async incoming(base) {
      checks++;
      return base === incoming.sha ? { sha: base, files: [] } : incoming;
    },
    async acceptBase() {},
    async commit() {
      throw new Error('A broken build must never reach GitHub');
    },
  };
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publisher = new Publisher(root, repository, rooms.coordinator, async (snapshot) => {
    await gate;
    await runBuild(snapshot);
  });
  publisher.subscribe(rooms.publishing);
  const sync = new RepositorySync(root, repository, rooms);
  const automatic = automaticSync(
    sync,
    () => rooms.hasClients() && publisher.state.kind !== 'building',
    100,
  );
  const { server, url } = await serveFixture(publisher, rooms, opened);
  return {
    root,
    publisher,
    release,
    url,
    checks: () => checks,
    update: (changes: IncomingChanges) => {
      incoming = changes;
    },
    async close() {
      automatic.stop();
      release();
      for (const room of opened) {
        for (const socket of room.clients.keys()) {
          socket.terminate();
        }
        await room.durable.flush();
        room.document.destroy();
      }
      rooms.sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function prepareProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-shared-publish-'));
  for (const directory of ['src/pages', 'public', '.stacki/studio/state', '.vercel']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { build: 'astro build' } }),
  );
  await writeFile(
    path.join(root, '.vercel/project.json'),
    JSON.stringify({ orgId: 'team_123', projectId: 'prj_123' }),
  );
  const source = '<h1>Original</h1>';
  for (const name of ['index', 'other']) {
    await writeFile(path.join(root, `src/pages/${name}.astro`), source);
  }
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/flowtricks/site.git']);
  return root;
}

async function serveFixture(
  publisher: Publisher,
  rooms: ReturnType<typeof createRooms>,
  opened: readonly Room[],
) {
  const bundle = await build({
    entryPoints: ['test/sharedPublishing.entry.tsx'],
    bundle: true,
    write: false,
    outdir: '/virtual',
    platform: 'browser',
    plugins: [browserBoundary],
    format: 'esm',
  });
  const server = createServer((request, response) => {
    if (serveSettings(publisher.root, rooms, request, response)) {
      return;
    }
    if (request.url === '/studio/api/status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ publishing: publisher.state }));
      return;
    }
    if (publishRoute(publisher, request, response, (request.url ?? '').split('?')[0] ?? '')) {
      return;
    }
    const asset = bundle.outputFiles.find((file) =>
      file.path.endsWith(request.url === '/app.css' ? '.css' : '.js'),
    );
    if (request.url === '/app.js' || request.url === '/app.css') {
      response.setHeader(
        'Content-Type',
        request.url.endsWith('.css') ? 'text/css' : 'application/javascript',
      );
      response.end(asset?.contents);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',
    );
  });
  server.on('upgrade', (request, socket, head) => {
    const file = new URL(request.url ?? '/', 'http://local').searchParams.get('file');
    const room = opened.find((room) => room.file === file);
    if (!room) {
      socket.destroy();
      return;
    }
    rooms.sockets.handleUpgrade(request, socket, head, (client) => room.attach(client));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function fixtureBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('Expected request bytes');
    }
    bytes += chunk.length;
    if (bytes > 16_384) {
      throw new Error('Settings exceed request limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function serveSettings(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.url?.startsWith('/studio/api/metadata')) {
    void metadataRoute(root, rooms, request, response, '/studio/api/metadata', () =>
      fixtureBody(request),
    ).catch(() => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'Invalid metadata request' }));
    });
    return true;
  }
  if (request.url === '/studio/api/publish/repository') {
    void serveRepositories(root, request, response);
    return true;
  }
  if (request.url === '/studio/api/publish/discover') {
    void serveLinkedProject(root, request, response);
    return true;
  }
  return false;
}

async function serveLinkedProject(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    const input: unknown = JSON.parse(await fixtureBody(request));
    const { provider } = parseDiscoveryRequest(input);
    response.setHeader('Content-Type', 'application/json');
    // This browser fixture exercises actual local links; API boundary coverage lives in unit tests.
    const projects =
      provider === 'vercel'
        ? [
            ...(await linkedPublishProject(root, provider)),
            {
              name: 'Personal website',
              hosting: {
                provider: 'vercel',
                organizationId: 'team_personal',
                projectId: 'prj_personal',
              },
            },
          ]
        : [];
    // These account choices exercise UI selection only; CLI discovery has separate boundary tests.
    const accounts =
      provider === 'github'
        ? [
            { id: 'flowtricks', name: 'flowtricks' },
            { id: 'tricksinc', name: 'tricksinc' },
          ]
        : provider === 'vercel'
          ? [
              { id: 'team_123', name: 'Work' },
              { id: 'team_personal', name: 'Personal' },
            ]
          : [];
    response.end(JSON.stringify({ kind: 'ready', accounts, projects }));
  } catch {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: 'Invalid discovery request' }));
  }
}

async function serveRepositories(root: string, request: IncomingMessage, response: ServerResponse) {
  try {
    const input: unknown = JSON.parse(await fixtureBody(request));
    const action = parseRepositoryRequest(input);
    const state = await repositoryState(root);
    // Only inventory is synthetic; connecting updates the temporary Git repository.
    const result =
      action.action === 'connect'
        ? await connectPublishingRepository(root, action)
        : {
            ok: true,
            value: {
              ...state,
              repositories: [
                state.connected,
                `${action.account}/next`,
                ...Array.from({ length: 6 }, (_, index) => `${action.account}/example-${index}`),
              ],
            },
          };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  } catch {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: 'Invalid repository request' }));
  }
}

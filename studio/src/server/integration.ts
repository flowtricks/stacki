import { withGitWorkspaceLease, isGitWorkspaceRead } from '../features/history/gitWorkspaceLease';
import { createAstroNotifications } from '../features/notifications/astroNotificationServer';
import { readPackagePreviews } from '../../vendor/stacki/electron/lib/componentSources';
import { METADATA_FILES } from '../../vendor/stacki/shared/properties/projectMetadata';
import { isDefaultsCanvas } from '../../vendor/stacki/shared/properties/defaultsCanvas';
import { instrumentVariant } from '../features/preview/variantRuntime';
import { mutateAsset } from '../features/assets/assetOperations';
import { configureRenderPush } from '../features/preview/renderPushServer';
import { managedAsset, MEDIA_EXT } from '../features/assets/assetStateTypes';
import { readAssetState, saveAssetState } from '../features/assets/assetState';
import { reauthorizeConnection } from '../features/collaboration/connectionLease';
import { projectCatalogs } from '../features/project/projectCatalogs';
import { sourceWatch } from '../features/project/sourceWatch';
import { parseProfile } from '../features/auth/profile';
import type { Duplex } from 'node:stream';
import type { AstroIntegration } from 'astro';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { prepareStudioLocal } from '../../vendor/stacki/electron/previewServer/studioLocalMove';
import { STUDIO_STATE_DIRECTORY } from '../../vendor/stacki/shared/properties/studioLocal';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { markSourceFile } from '../../vendor/stacki/electron/previewServer/previewMarkers';
import {
  componentPreviewPlugin,
  renderComponentPreviewPage,
} from '../../vendor/stacki/electron/previewServer/componentPreview';
import { createRooms } from '../features/collaboration/rooms';
import { safePath, preparePath, readSource } from '../features/project/projectServer';
import { filePath, sourcePath, string, record, MAX_SOURCE } from '../shared/validation';
import { featureRoutes } from './featureRoutes';
import { saveAsset } from '../features/storage/assetStorage';
import { interceptBrowserReloads } from '../features/preview/browserReloads';

interface Options {
  readonly root: string;
  readonly assets: string;
  readonly port: number;
  readonly editing?: 'source' | 'draft';
}
interface PreviewOptions extends Options {
  readonly trailingSlash: 'always' | 'never' | 'ignore';
}
import type { ViteDevServer, Plugin } from 'vite';
export default function studio(options: Options): AstroIntegration {
  let prioritizeRequests = () => {};
  const rooms = createRooms(options.root);
  const features = featureRoutes(options.root, rooms);
  return {
    name: 'astro-studio-cms',
    hooks: {
      'astro:server:setup': ({ server }) => {
        prioritizeRequests = () => prioritizeStudioRequests(server);
      },
      'astro:server:start': () => prioritizeRequests(),
      'astro:config:setup': async ({
        updateConfig,
        addMiddleware,
        injectRoute,
        command,
        config,
      }) => {
        if (command === 'dev') {
          // `.stacki/studio/` ignores its own contents; an older `.studio-state` moves in.
          prepareStudioLocal(options.root);
          await mkdir(path.join(options.root, STUDIO_STATE_DIRECTORY), { recursive: true });
          const entrypoint = path.join(
            options.root,
            '.stacki/studio/state/component-preview.astro',
          );
          await writeFile(entrypoint, renderComponentPreviewPage());
          injectRoute({ pattern: '/__avb/preview', entrypoint });
        }
        addMiddleware({
          entrypoint: path.join(options.assets, 'previewMiddleware.mjs'),
          order: 'pre',
        });
        updateConfig({
          vite: {
            plugins: [
              sourceWatch(),
              componentPreviewPlugin([options.root], readPackagePreviews),
              previewPlugin({ ...options, trailingSlash: config.trailingSlash }, features, rooms),
            ],
          },
        });
      },
    },
  };
}
function prioritizeStudioRequests(server: ViteDevServer): void {
  // Astro prepends route policy after Vite configureServer and server:setup.
  // At server:start, move only our authenticated namespace ahead of site routing.
  const index = server.middlewares.stack.findIndex(
    (entry) => typeof entry.handle === 'function' && entry.handle.name === 'studioRequests',
  );
  if (index >= 0) {
    const [entry] = server.middlewares.stack.splice(index, 1);
    if (entry) {
      server.middlewares.stack.unshift(entry);
    }
  }
}

function previewPlugin(
  options: PreviewOptions,
  features: ReturnType<typeof featureRoutes>,
  rooms: ReturnType<typeof createRooms>,
): Plugin {
  return {
    name: 'studio-preview-markers',
    apply: 'serve',
    enforce: 'pre',
    load(id: string) {
      if (id.includes('?')) {
        return undefined;
      }
      const marked = markSourceFile(id, [options.root]);
      return marked
        ? instrumentVariant(
            marked.code,
            path.relative(options.root, id).split(path.sep).join('/'),
            path.join(options.assets, 'variantRuntime.mjs'),
          ) +
            (marked.page
              ? `\n<meta name="studio-parent-origin" content="${process.env['STUDIO_PARENT_ORIGIN'] ?? ''}">` +
                '\n<script is:inline type="module" src="/studio/morph.js"></script>\n<script is:inline type="module" async src="/studio/preview.js"></script>'
              : '')
        : undefined;
    },
    configureServer(server: ViteDevServer) {
      configureStudioServer(server, options, features, rooms);
      server.httpServer?.once('close', () => rooms.sockets.close());
    },
  };
}

function authorized(request: IncomingMessage, options: Options) {
  const token = process.env['STUDIO_CONTAINER_TOKEN'];
  if (token) {
    return request.headers['x-studio-token'] === token;
  }
  const host = request.headers.host;
  const allowed = [
    `localhost:${options.port}`,
    `127.0.0.1:${options.port}`,
    `[::1]:${options.port}`,
  ];
  if (!host || !allowed.includes(host)) {
    return false;
  }
  const origin = request.headers.origin;
  return !origin || origin === `http://${host}`;
}
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Options,
  features: ReturnType<typeof featureRoutes>,
  rooms: ReturnType<typeof createRooms>,
  catalogs: ReturnType<typeof projectCatalogs>,
) {
  if (!authorized(request, options)) {
    json(response, 403, { error: 'Unauthorized studio request' });
    return;
  }
  const work = () =>
    handleRequestInWorkspace(request, response, options, features, rooms, catalogs);
  if (
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    isGitWorkspaceRead(new URL(request.url ?? '/', 'http://studio').pathname)
  ) {
    return work();
  }
  const expected = request.headers['x-studio-workspace'];
  return withGitWorkspaceLease(
    options.root,
    typeof expected === 'string' ? expected : undefined,
    work,
  );
}
async function handleRequestInWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  options: Options,
  features: ReturnType<typeof featureRoutes>,
  rooms: ReturnType<typeof createRooms>,
  catalogs: ReturnType<typeof projectCatalogs>,
) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authorized(request, options)) {
    json(response, 403, { error: 'Unauthorized studio request' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://studio');
  if (url.pathname === '/studio/api/session') {
    json(response, 200, { kind: 'local', editing: options.editing ?? 'draft' });
    return;
  }
  if (await features(request, response, url.pathname, () => body(request))) {
    return;
  }
  if (url.pathname === '/studio/api/preview-url' && request.method === 'GET') {
    sendPreviewURL(request, response, url);
    return;
  }
  if (url.pathname === '/studio/api/assets' && request.method === 'POST') {
    const input: unknown = JSON.parse(await body(request));
    json(response, 200, await rooms.coordinator.run(() => mutateAsset(options.root, input)));
    return;
  }
  if (url.pathname === '/studio/api/assets' && request.method === 'GET') {
    await sendCatalog(response, catalogs.assets);
    return;
  }
  if (url.pathname === '/studio/api/project' && request.method === 'GET') {
    await sendCatalog(response, catalogs.project);
    return;
  }
  if (request.method === 'GET' && (await sendSourceRead(response, url, options, catalogs))) {
    return;
  }
  if (url.pathname === '/studio/api/asset' && request.method === 'GET') {
    await sendAsset(response, options.root, url);
    return;
  }
  if (url.pathname === '/studio/api/create' && request.method === 'POST') {
    await createFile(request, response, options, rooms, url);
    return;
  }
  if (url.pathname === '/studio/api/upload' && request.method === 'POST') {
    await uploadAsset(request, response, options, rooms, url);
    return;
  }
  const name =
    url.pathname === '/studio' || url.pathname === '/studio/'
      ? 'index.html'
      : url.pathname.slice('/studio/'.length);
  if (!['index.html', 'studio.js', 'studio.css', 'preview.js', 'morph.js'].includes(name)) {
    json(response, 404, { error: 'Not found' });
    return;
  }
  response.setHeader('Content-Type', mime(name));
  response.end(await readFile(path.join(options.assets, name)));
}
function mime(file: string): string {
  const extension = path.extname(file).slice(1);
  return (
    (
      {
        html: 'text/html; charset=utf-8',
        js: 'text/javascript',
        css: 'text/css',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        avif: 'image/avif',
        gif: 'image/gif',
        pdf: 'application/pdf',
        mp4: 'video/mp4',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}
async function sendCatalog(
  response: ServerResponse,
  read: () => Promise<{ readonly value: unknown; readonly timing: string }>,
) {
  const catalog = await read();
  response.setHeader('Server-Timing', catalog.timing);
  json(response, 200, catalog.value);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  return (await bodyBytes(request, MAX_SOURCE + 1000)).toString('utf8');
}
async function bodyBytes(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of request) {
    const value: unknown = input;
    if (!Buffer.isBuffer(value) && typeof value !== 'string') {
      throw new Error('Invalid request chunk');
    }
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maximum) {
      throw new Error('Request is too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function configureStudioServer(
  server: ViteDevServer,
  options: PreviewOptions,
  features: ReturnType<typeof featureRoutes>,
  rooms: ReturnType<typeof createRooms>,
) {
  const render = configureRenderPush(server, options.port, options.root);
  // Vite owns source invalidation. Rendering immediately after a room write
  // races its watcher and renders the same edit again when HMR finishes.
  interceptBrowserReloads(server, render.invalidate);
  const stopRenderTiming = rooms.onWrite((_file, mode) => render.sourceWritten(mode));
  server.httpServer?.once('close', stopRenderTiming);
  const subscribe = createAstroNotifications(server, options.root);
  configureStudioRequests(server, options, features, rooms, subscribe);
  server.httpServer?.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://studio');
    if (url.pathname !== '/studio/sync') {
      return;
    }
    if (!authorized(request, options)) {
      socket.destroy();
      return;
    }
    void withGitWorkspaceLease(options.root, url.searchParams.get('workspace') ?? undefined, () =>
      rooms.get(url.searchParams.get('file') ?? ''),
    )
      .then((room) => {
        rooms.sockets.handleUpgrade(request, socket, head, (client) =>
          room.attach(
            client,
            process.env['STUDIO_CONTAINER_TOKEN']
              ? parseProfile({
                  login: request.headers['x-studio-user'],
                  id: Number(request.headers['x-studio-user-id']),
                })
              : undefined,
            reauthorizeConnection(request),
            url.searchParams.get('participant') ?? undefined,
          ),
        );
      })
      .catch(() => socket.destroy());
  });
  configureProjectWatching(server, options.root, rooms);
}

function configureProjectWatching(
  server: ViteDevServer,
  root: string,
  rooms: ReturnType<typeof createRooms>,
) {
  server.watcher.on('all', (event, file) => {
    if (
      ['change', 'add', 'unlink'].includes(event) &&
      /\.(astro|json|md|mdx|mdoc|markdown|[cm]?[jt]sx?|yaml|yml|toml|csv|ndjson)$/.test(file)
    ) {
      server.ws.send({ type: 'custom', event: 'studio:cms-changed' });
    }
  });
  server.watcher.on('change', (file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const metadata = Object.values(METADATA_FILES).some((name) => name === relative);
    if (relative.startsWith('src/') || metadata || isDefaultsCanvas(relative)) {
      void rooms.changed(relative);
    }
    if (/^(src|public)\/.+\.css$/.test(relative)) {
      server.ws.send({ type: 'custom', event: 'studio:css-changed' });
    }
  });
}

// Reads of a project file: its source, or what its call to one of its imports
// returns, sampled for the binding picker (valueSampler.ts). False: not a read.
async function sendSourceRead(
  response: ServerResponse,
  url: URL,
  options: Options,
  catalogs: ReturnType<typeof projectCatalogs>,
): Promise<boolean> {
  if (url.pathname === '/studio/api/file') {
    const file = sourcePath(url.searchParams.get('file'));
    json(response, 200, { file, source: await readSource(options.root, file) });
    return true;
  }
  if (url.pathname === '/studio/api/sample-value') {
    const file = sourcePath(url.searchParams.get('file'));
    const spec = string(url.searchParams.get('spec'), 500);
    const name = string(url.searchParams.get('name'), 200);
    json(response, 200, await catalogs.values({ file, spec, name }));
    return true;
  }
  return false;
}

async function createFile(
  request: IncomingMessage,
  response: ServerResponse,
  options: Options,
  rooms: ReturnType<typeof createRooms>,
  _url: URL,
) {
  const input = record(JSON.parse(await body(request)));
  const file = sourcePath(input['file']);
  if (!/^src\/(pages|content|data)\//.test(file)) {
    throw new Error('Create pages or collection items here');
  }
  await rooms.coordinator.run(async () => {
    const destination = await preparePath(options.root, file);
    await writeFile(destination, string(input['source']), { flag: 'wx' });
    await rooms.get(file);
  });
  json(response, 201, { file });
  return;
}
async function uploadAsset(
  request: IncomingMessage,
  response: ServerResponse,
  options: Options,
  rooms: ReturnType<typeof createRooms>,
  url: URL,
) {
  const file = filePath(url.searchParams.get('file'));
  managedAsset(file);
  const bytes = await bodyBytes(request, 20_000_000);
  await rooms.coordinator.run(async () => {
    let exists = false;
    try {
      await access(await safePath(options.root, file));
      exists = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (exists) {
      throw new Error('An asset with this name already exists');
    }
    await saveAsset(options.root, file, bytes);
    const state = await readAssetState(options.root);
    if (state.deleted.includes(file)) {
      await saveAssetState(options.root, {
        ...state,
        deleted: state.deleted.filter((item) => item !== file),
      });
    }
  });
  json(response, 201, { file });
  return;
}

function sendPreviewURL(request: IncomingMessage, response: ServerResponse, url: URL) {
  const page = url.searchParams.get('page') ?? '/';
  if (!page.startsWith('/') || page.startsWith('//') || page.includes('\\')) {
    throw new Error('Invalid preview path');
  }
  const hash = url.searchParams.get('mode') === 'interactive' ? '#avb-preview' : '#avb-design';
  json(response, 200, { url: page + hash, origin: `http://${request.headers.host}` });
}

async function sendAsset(response: ServerResponse, root: string, url: URL) {
  const file = filePath(url.searchParams.get('file'));
  if (!MEDIA_EXT.test(file)) {
    throw new Error('Unsupported asset');
  }
  const bytes = await readFile(await safePath(root, file));
  response.setHeader('Content-Type', mime(file));
  response.setHeader(
    'Content-Security-Policy',
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  );
  response.end(bytes);
}

function configureStudioRequests(
  server: ViteDevServer,
  options: PreviewOptions,
  features: ReturnType<typeof featureRoutes>,
  rooms: ReturnType<typeof createRooms>,
  subscribe: ReturnType<typeof createAstroNotifications>,
) {
  const catalogs = projectCatalogs(server, options.root);
  // Accepted writes invalidate before their reply, independently of watcher timing.
  const stopCatalogs = rooms.onWrite(catalogs.invalidate);
  server.httpServer?.once('close', stopCatalogs);
  server.middlewares.use(function studioRequests(request, response, next) {
    const url = new URL(request.url ?? '/', 'http://studio');
    const pathname = url.pathname;
    if (pathname === '/__avb/preview' || pathname === '/__avb/preview/') {
      // Internal preview links remain stable while Astro enforces the site's route policy.
      url.pathname = options.trailingSlash === 'always' ? '/__avb/preview/' : '/__avb/preview';
      request.url = url.pathname + url.search;
      next();
      return;
    }
    if (pathname !== '/studio' && !pathname.startsWith('/studio/')) {
      next();
      return;
    }
    if (
      request.url === '/studio/api/astro-events' &&
      request.method === 'GET' &&
      authorized(request, options)
    ) {
      subscribe(response, reauthorizeConnection(request));
      return;
    }
    void handleRequest(request, response, options, features, rooms, catalogs)
      .catch((error) =>
        json(response, 400, {
          error: error instanceof Error ? error.message : 'Request failed',
        }),
      )
      .finally(() => {
        // Uploads and metadata writes also change catalogs outside document rooms.
        if (request.method !== 'GET') {
          catalogs.invalidate();
        }
      });
  });
}

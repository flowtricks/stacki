// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the dev server route that renders one
// component with props Design mode chose, and writes nothing.
//
// POST /__avb/design-render takes { component, props, slots } (shared/designMode/designModeContract.ts) and
// answers the component's HTML, rendered by Astro's container API inside the running dev server: the same
// compiler, the same marked module graph and the same project code the canvas renders with, but nothing is
// written anywhere — not a page, not a temporary file. The container is created once per server.
//
// Why a route and not the canvas's hover preview (shared/page/variantOverride.ts): that override changes one
// prop of one instance per request, and a design changes several props of an instance at once, booleans and
// lists included. Why the container: it renders a component by itself from props and slot HTML, with no page
// to stand it in; the instance's own slot content travels as HTML from the frame.
//
// Like every /__avb route it answers this computer only (loopbackGuard.ts runs first).
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { DESIGN_MODE_ENABLED, DESIGN_MODE_LIMITS, DESIGN_RENDER_ROUTE, parseDesignRenderBody } from '../../../shared/designMode/designModeContract';

interface RenderServer {
  readonly middlewares: {
    readonly use: (route: string, handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void) => void;
  };
  readonly environments?: Readonly<Record<string, { readonly runner?: { readonly import: (file: string) => Promise<unknown> } }>>;
  readonly ssrLoadModule?: (file: string) => Promise<unknown>;
}

/** The body bytes the route reads at most: every slot and prop at its bound, encoded, with room to spare. */
const BODY_BYTES_MAX = DESIGN_MODE_LIMITS.slotCharsMax * 2;

/** The Vite plugin the generated preview config adds; a plugin with no hooks while the feature is switched off. */
export function designModeRenderPlugin(projectDirectories: readonly string[]): {
  readonly name: string;
  readonly configureServer?: (server: RenderServer) => void;
} {
  if (!DESIGN_MODE_ENABLED) {
    return { name: 'stacki-design-mode-render' };
  }
  const root = projectDirectories[0];
  if (root === undefined) {
    throw new Error('Assertion failed: designModeRenderPlugin: a project root');
  }
  return {
    name: 'stacki-design-mode-render',
    configureServer(server: RenderServer): void {
      let container: Promise<ContainerLike> | undefined;
      server.middlewares.use(DESIGN_RENDER_ROUTE, (request, response) => {
        const lazyContainer = (): Promise<ContainerLike> => (container ??= createContainer(server));
        void handleRender(server, root, request, response, lazyContainer);
      });
    },
  };
}

interface ContainerLike {
  readonly renderToString: (component: unknown, options: { readonly props: unknown; readonly slots: unknown }) => Promise<string>;
}

/** The container class from a loaded `astro/container`, wherever the loader put the export. */
function containerFactory(module: unknown): unknown {
  return fieldOf(module, 'experimental_AstroContainer') ?? fieldOf(fieldOf(module, 'default'), 'experimental_AstroContainer');
}

async function createContainer(server: RenderServer): Promise<ContainerLike> {
  // Loaded through the dev server, as the components are, so the container and the components share one Astro runtime.
  const factory = containerFactory(await load(server, 'astro/container'));
  const create = fieldOf(factory, 'create');
  if (typeof create !== 'function') {
    throw new Error("This Astro has no container API (astro/container's experimental_AstroContainer.create)");
  }
  const made: unknown = await Reflect.apply(create, factory, []);
  const render = fieldOf(made, 'renderToString');
  if (typeof render !== 'function') {
    throw new Error('The Astro container cannot render to a string');
  }
  return { renderToString: async (component, options) => String(await Reflect.apply(render, made, [component, options])) };
}

function fieldOf(value: unknown, key: string): unknown {
  // A class is a function: the container's factory is one.
  return (typeof value === 'object' && value !== null) || typeof value === 'function' ? Reflect.get(value, key) : undefined;
}

async function load(server: RenderServer, id: string): Promise<unknown> {
  // Astro 6+ renders through the SSR environment's runner; older Vite has ssrLoadModule (previewWarmup.ts does the same).
  const runner = server.environments?.['ssr']?.runner;
  if (runner !== undefined) {
    return await runner.import(id);
  }
  if (server.ssrLoadModule === undefined) {
    throw new Error('This dev server cannot load modules');
  }
  return await server.ssrLoadModule(id);
}

async function handleRender(
  server: RenderServer,
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  container: () => Promise<ContainerLike>,
): Promise<void> {
  if (request.method !== 'POST') {
    finish(response, 405, 'POST only');
    return;
  }
  let body: unknown;
  try {
    const text = await readBody(request);
    body = text === undefined ? undefined : parseJson(text);
  } catch {
    body = undefined;
  }
  const parsed = parseDesignRenderBody(body);
  if (parsed === undefined) {
    finish(response, 400, 'Not a design render request');
    return;
  }
  const file = path.resolve(root, parsed.component);
  if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) {
    finish(response, 404, 'No such component');
    return;
  }
  try {
    const component = fieldOf(await load(server, '/' + parsed.component), 'default');
    if (component === undefined) {
      finish(response, 422, 'The component has no default export');
      return;
    }
    const html = await (await container()).renderToString(component, { props: parsed.props, slots: parsed.slots });
    if (html.length > DESIGN_MODE_LIMITS.replyCharsMax) {
      finish(response, 413, 'The rendering is too large');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  } catch (error: unknown) {
    // The component's own error, as Astro reports it: the frame shows a toast and keeps the old rendering.
    finish(response, 500, String(error instanceof Error ? error.message : error).slice(0, DESIGN_MODE_LIMITS.detailCharsMax));
  }
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function finish(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > BODY_BYTES_MAX) {
        request.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

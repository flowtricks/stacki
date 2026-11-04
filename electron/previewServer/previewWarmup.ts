// Compile a small number of page templates after the first page is served.
// Loading modules primes Vite's graph without rendering pages or running getStaticPaths.
//
// The component preview route is rendered once as well. Its globs reach every component,
// and Astro's first render of the route crawls and compiles all of them to collect their
// styles: about four seconds on a 140-component site, paid by the first palette hover.
// Importing the route module alone does not crawl, so warmup requests the route itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { assert } from '../../shared/core/assert';

interface WarmupRoute {
  readonly origin?: string;
  readonly entrypoint?: string;
}

interface WarmupServer {
  readonly middlewares: {
    readonly use: (handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void) => void;
  };
  readonly httpServer?: {
    readonly once: (event: 'close', callback: () => void) => void;
    // Node returns an AddressInfo, a pipe name, or null before listening; parsed where read.
    readonly address?: () => unknown;
  };
  readonly environments?: Readonly<Record<string, { readonly runner?: { readonly import: (file: string) => Promise<unknown> } }>>;
  readonly ssrLoadModule: (file: string) => Promise<unknown>;
}

export interface WarmupPlan {
  /** Page modules to compile, resolved lazily because routes resolve after setup. */
  readonly files: () => readonly string[];
  /** The component preview route to render, or undefined when the address is unknown. */
  readonly previewURL: () => string | undefined;
  readonly request: (url: string) => Promise<void>;
}

interface WarmupConfig {
  readonly base?: string;
  readonly trailingSlash?: string;
}

const PAGE_TEMPLATES_MAX = 2;
const ROUTES_INSPECTED_MAX = 10000;
const PREVIEW_REQUEST_TIMEOUT_MS = 60_000;

export function previewWarmupIntegration(project: string) {
  let files: readonly string[] = [];
  let config: WarmupConfig = {};
  return {
    name: 'stacki-preview-warmup',
    hooks: {
      'astro:config:done': ({ config: done }: { readonly config: WarmupConfig }): void => {
        config = done;
      },
      'astro:routes:resolved': ({ routes }: { readonly routes: readonly WarmupRoute[] }): void => {
        files = previewWarmupFiles(routes).map((file) => path.resolve(project, file));
      },
      'astro:server:setup': ({ server, logger }: { readonly server: WarmupServer; readonly logger: { readonly warn: (message: string) => void } }): void => {
        previewWarmupAfterPage(
          server,
          {
            files: () => files,
            previewURL: () => previewWarmupURL(server.httpServer?.address?.(), config),
            request: previewWarmupRequest,
          },
          (error) => logger.warn(String(error)),
        );
      },
    },
  };
}

/** The component preview route on this server, honouring the project's base and slash policy. */
export function previewWarmupURL(input: unknown, config: WarmupConfig): string | undefined {
  const address = tcpAddress(input);
  if (address === undefined) {
    return undefined;
  }
  assert(Number.isSafeInteger(address.port), 'A listening server has an integer port');
  const wildcard = address.address === '::' || address.address === '0.0.0.0';
  const host = wildcard ? 'localhost' : address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const base = (config.base ?? '/').replace(/\/+$/, '');
  // Astro returns a 404 when an injected page violates the project's slash policy.
  const route = config.trailingSlash === 'always' ? '/__avb/preview/' : '/__avb/preview';
  const url = `http://${host}:${address.port}${base}${route}`;
  assert(url.includes('/__avb/preview'), 'Warmup requests the preview route');
  return url;
}

function tcpAddress(input: unknown): Pick<AddressInfo, 'address' | 'family' | 'port'> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('address' in input) || !('family' in input) || !('port' in input)) {
    return undefined;
  }
  const { address, family, port } = input;
  if (typeof address !== 'string' || typeof family !== 'string' || typeof port !== 'number') {
    return undefined;
  }
  return { address, family, port };
}

async function previewWarmupRequest(url: string): Promise<void> {
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS) });
  // Read the body so the render completes before warmup reports success.
  await response.arrayBuffer();
  if (response.status !== 200) {
    throw new Error(`Component preview warmup returned HTTP ${response.status}`);
  }
}

export function previewWarmupFiles(routes: readonly WarmupRoute[]): readonly string[] {
  const files = new Set<string>();
  for (const route of routes.slice(0, ROUTES_INSPECTED_MAX)) {
    const file = route.entrypoint;
    if (route.origin !== 'project' || !file || !/\.(astro|md|mdx)$/.test(file)) {
      continue;
    }
    // The homepage is already compiled by the request that starts this warmup.
    if (/(?:^|[/\\])pages[/\\](index|404|500)\.(astro|md|mdx)$/.test(file)) {
      continue;
    }
    files.add(file);
  }
  assert(files.size <= ROUTES_INSPECTED_MAX, 'Warmup candidates must remain bounded');
  // Dynamic templates commonly share the site's largest layout. Prefer broad
  // routes before narrow ones, so one compilation benefits many destinations.
  const selected = [...files]
    .sort((left, right) => Number(right.includes('[')) - Number(left.includes('[')) || left.length - right.length || left.localeCompare(right))
    .slice(0, PAGE_TEMPLATES_MAX);
  assert(selected.length <= PAGE_TEMPLATES_MAX, 'Warmup must not compile the entire site');
  return selected;
}

export function previewWarmupAfterPage(server: WarmupServer, plan: WarmupPlan, report: (error: unknown) => void): void {
  let state: 'waiting' | 'scheduled' | 'closed' = 'waiting';
  let timer: ReturnType<typeof setTimeout> | undefined;
  server.httpServer?.once('close', () => {
    state = 'closed';
    clearTimeout(timer);
  });
  server.middlewares.use((request, response, next) => {
    if (state === 'waiting' && request.method === 'GET') {
      response.once('finish', () => {
        const contentType = response.getHeader('content-type');
        if (state !== 'waiting' || typeof contentType !== 'string') {
          return;
        }
        if (!contentType.startsWith('text/html') || response.statusCode !== 200) {
          return;
        }
        state = 'scheduled';
        // Let the initial page and its browser assets go first, then use idle time.
        timer = setTimeout(() => {
          void previewWarmupRun(server, plan, () => state === 'closed').catch(report);
        }, 500);
        timer.unref();
      });
    }
    next();
  });
}

async function previewWarmupRun(server: WarmupServer, plan: WarmupPlan, closed: () => boolean): Promise<void> {
  await previewWarmupModules(server, plan.files(), closed);
  const url = plan.previewURL();
  if (closed() || url === undefined) {
    return;
  }
  await plan.request(url);
}

async function previewWarmupModules(server: WarmupServer, files: readonly string[], closed: () => boolean): Promise<void> {
  for (const file of files.slice(0, PAGE_TEMPLATES_MAX)) {
    if (closed()) {
      return;
    }
    // Astro 6+ renders through the SSR environment; older Vite uses ssrLoadModule.
    const runner = server.environments?.['ssr']?.runner;
    if (runner) {
      await runner.import(file);
    } else {
      await server.ssrLoadModule(file);
    }
  }
}

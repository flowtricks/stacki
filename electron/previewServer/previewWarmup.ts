// Compile a small number of page templates after the first page is served.
// Loading modules primes Vite's graph without rendering pages or running getStaticPaths.
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  readonly httpServer?: { readonly once: (event: 'close', callback: () => void) => void };
  readonly environments?: Readonly<Record<string, { readonly runner?: { readonly import: (file: string) => Promise<unknown> } }>>;
  readonly ssrLoadModule: (file: string) => Promise<unknown>;
}

const PAGE_TEMPLATES_MAX = 2;
const ROUTES_INSPECTED_MAX = 10000;

export function previewWarmupIntegration(project: string) {
  let files: readonly string[] = [];
  return {
    name: 'stacki-preview-warmup',
    hooks: {
      'astro:routes:resolved': ({ routes }: { readonly routes: readonly WarmupRoute[] }): void => {
        files = previewWarmupFiles(routes).map((file) => path.resolve(project, file));
      },
      'astro:server:setup': ({ server, logger }: { readonly server: WarmupServer; readonly logger: { readonly warn: (message: string) => void } }): void => {
        previewWarmupAfterPage(
          server,
          () => files,
          (error) => logger.warn(String(error)),
        );
      },
    },
  };
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

export function previewWarmupAfterPage(server: WarmupServer, files: () => readonly string[], report: (error: unknown) => void): void {
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
          void previewWarmupModules(server, files(), () => state === 'closed').catch(report);
        }, 500);
        timer.unref();
      });
    }
    next();
  });
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

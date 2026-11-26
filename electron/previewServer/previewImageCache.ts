// The preview dev server's images are always asked for again.
//
// Astro's image endpoint (`/_image`, dev) answers with `Cache-Control: public, max-age=31536000`,
// and its URL carries the source path and the transform, no content hash. An image replaced under
// the same name (a git pull, an export over the old file) therefore keeps showing the old picture:
// the browser never asks again, across restarts too, and clearing the HTTP cache does not reach the
// copy a running window holds in memory. The one place that works is the response itself, so this
// Vite plugin sends it with `no-cache`: the browser may keep it, and asks before using it. The ETag
// Astro sets is left in place.
//
// Only the image endpoint is touched. The rest of the dev server already says `no-cache` or
// `no-store` (public/ files, source files, fonts), and its one long `immutable` answer is a
// prebundled dependency whose `?v=` changes with its content.
//
// It applies to `serve` only, and exists only in the configs Stacki generates under
// node_modules/.avb: the project's build and its own config file are never touched. It runs inside
// the project's dev server, a plain Node process, so it requires only unpacked modules
// (package.json build.asarUnpack).
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { assert } from '../../shared/core/assert';

/** Astro's image endpoint unless the project names another (`image.endpoint.route`). */
export const IMAGE_ROUTE_DEFAULT = '/_image';

export const IMAGE_CACHE_CONTROL = 'no-cache';

const CACHE_HEADER = 'cache-control';

/**
 * Whether `url`, a request's path and query, asks the image endpoint at `route`. The route is matched
 * at the end of the path, so a configured `base` (still on the URL, or already taken off by an earlier
 * middleware) makes no difference, and neither does a trailing slash.
 */
export function isImageRequest(url: string | undefined, route: string): boolean {
  assert(route.startsWith('/'), 'isImageRequest: the route starts with a slash');
  const path = withoutTrailingSlash((url ?? '/').split('?')[0] ?? '/');
  return path.endsWith(withoutTrailingSlash(route));
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The image routes of a project whose config's `image` value is `image` (parsed here: it is the
 * project's own data). The default is always one of them.
 */
export function imageRoutesOf(image: unknown): readonly string[] {
  const route = propertyOf(propertyOf(image, 'endpoint'), 'route');
  if (typeof route !== 'string') {
    return [IMAGE_ROUTE_DEFAULT];
  }
  // A route of "/" alone would match every directory address.
  const named = withoutTrailingSlash(route.startsWith('/') ? route : `/${route}`);
  if (named === '/' || named === IMAGE_ROUTE_DEFAULT) {
    return [IMAGE_ROUTE_DEFAULT];
  }
  return [IMAGE_ROUTE_DEFAULT, named];
}

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

/**
 * Makes `response` go out with `no-cache` whatever is set on it later. Every way of sending headers
 * passes through writeHead (Node calls it itself for setHeader followed by end), so it is the one
 * method replaced: a cache header given to it is dropped, and ours is set just before the original runs.
 */
export function forceRevalidation(response: ServerResponse): void {
  const writeHead = response.writeHead.bind(response);
  function writeHeadRevalidating(
    status: number,
    second?: string | OutgoingHttpHeaders | ReadonlyArray<unknown>,
    third?: OutgoingHttpHeaders | ReadonlyArray<unknown>,
  ): ServerResponse {
    const message = typeof second === 'string' ? second : undefined;
    const headers = typeof second === 'string' ? third : second;
    response.setHeader(CACHE_HEADER, IMAGE_CACHE_CONTROL);
    const kept = headers === undefined ? undefined : withoutCacheHeader(headers);
    return message === undefined ? writeHead(status, kept) : writeHead(status, message, kept);
  }
  Reflect.set(response, 'writeHead', writeHeadRevalidating);
}

// writeHead takes headers as an object, or as one flat list of names and values in turn.
function withoutCacheHeader(headers: OutgoingHttpHeaders | ReadonlyArray<unknown>): OutgoingHttpHeaders {
  if (!isList(headers)) {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== CACHE_HEADER));
  }
  assert(headers.length % 2 === 0, 'withoutCacheHeader: a header list is names and values in turn');
  const kept: Array<readonly [string, string[]]> = [];
  const byName = new Map<string, string[]>();
  for (let index = 0; index < headers.length; index += 2) {
    const name = String(headers[index]).toLowerCase();
    if (name !== CACHE_HEADER) {
      let values = byName.get(name);
      if (values === undefined) {
        values = [];
        byName.set(name, values);
        kept.push([name, values]);
      }
      // A repeated name (set-cookie) keeps every value.
      values.push(String(headers[index + 1]));
    }
  }
  return Object.fromEntries(kept.map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
}

function isList(value: OutgoingHttpHeaders | ReadonlyArray<unknown>): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

interface PreviewServer {
  readonly middlewares: { readonly use: (handler: Middleware) => void };
}

/**
 * The Vite plugin the generated configs list. `image` is the project config's `image` value. First by
 * `enforce`, so its middleware sees a request before whatever serves it.
 */
export function previewImageCachePlugin(image: unknown) {
  const routes = imageRoutesOf(image);
  return {
    name: 'stacki-preview-image-cache',
    apply: 'serve' as const,
    enforce: 'pre' as const,
    configureServer(server: PreviewServer): void {
      server.middlewares.use((request, response, next) => {
        if (routes.some((route) => isImageRequest(request.url, route))) {
          forceRevalidation(response);
        }
        next();
      });
    },
  };
}

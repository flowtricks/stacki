import { configureVariants } from './variantServer';
import type { ViteDevServer, WebSocketClient } from 'vite';
import type { IncomingMessage } from 'node:http';
import { maintainConnection, reauthorizeConnection } from '../collaboration/connectionLease';
import { RenderPush, type RenderTarget } from './renderPush';
import { renderScope } from './renderRequest';

export function renderPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) {
    return undefined;
  }
  const path = input.path;
  if (typeof path !== 'string' || path.length > 2000 || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) {
    return undefined;
  }
  const url = new URL(path, 'http://studio');
  const defaults = /^\/__avb\/preview\?defaults=[a-f0-9-]{36}$/.test(path);
  if (url.origin !== 'http://studio' || (!defaults && /^\/(studio|@|__)/.test(url.pathname))) {
    return undefined;
  }
  return url.pathname + url.search;
}

export function configureRenderPush(server: ViteDevServer, port: number, root: string) {
  server.middlewares.use((request, _response, next) => {
    if (request.headers['x-studio-render'] === 'patch') {
      renderScope.run('patch', next);
    } else {
      next();
    }
  });
  const push = new RenderPush((path) => renderPage(port, path));
  const targets = new Map<WebSocketClient, RenderTarget>();
  const authorized = previewConnections(server);
  const invalidateVariants = configureVariants(server, root, authorized, (path, headers) => renderPage(port, path, headers), renderPath);
  server.ws.on('studio:render-subscribe', (input: unknown, client: WebSocketClient) => {
    const path = renderPath(input);
    if (!authorized.has(client.socket) || !path || (!targets.has(client) && targets.size >= 100)) {
      return;
    }
    let target = targets.get(client);
    if (!target) {
      target = {
        gzip: !!input && typeof input === 'object' && 'encoding' in input && input.encoding === 'gzip',
        send: (event, data) => {
          if (client.socket.readyState === 1 && client.socket.bufferedAmount < 8_000_000) {
            client.send(event, data);
          }
        },
      };
      targets.set(client, target);
      client.socket.once('close', () => {
        const target = targets.get(client);
        if (target) {
          push.unsubscribe(target);
        }
        targets.delete(client);
      });
    }
    push.subscribe(path, target);
  });
  server.httpServer?.once('close', () => push.close());
  return {
    sourceWritten: push.sourceWritten.bind(push),
    invalidate: () => {
      invalidateVariants();
      push.invalidate();
    },
  };
}

function previewConnections(server: ViteDevServer) {
  const authorized = new WeakSet<WebSocketClient['socket']>();
  server.ws.on('connection', (socket: WebSocketClient['socket'], request: IncomingMessage) => {
    const token = process.env['STUDIO_CONTAINER_TOKEN'];
    if (token) {
      const authorize = reauthorizeConnection(request, 'preview');
      if (request.headers['x-studio-token'] !== token || !authorize) {
        socket.close(4001, 'Preview session required');
        return;
      }
      // HTML now travels on this connection, so it must expire/recheck access
      // just like the document connection instead of relying on future fetches.
      maintainConnection(socket, authorize);
    }
    authorized.add(socket);
  });
  return authorized;
}

async function renderPage(port: number, path: string, headers?: Record<string, string>): Promise<string> {
  // Keep Astro compilation inside the container; the browser receives the result
  // on its existing authenticated preview socket instead of another WAN request.
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { ...headers, 'x-studio-render': 'patch' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if ((!response.ok && response.status !== 404) || !response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Preview render failed');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Empty preview render');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > 4_000_000) {
      await reader.cancel();
      throw new Error('Preview render limit exceeded');
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const baseline = html.lastIndexOf('<script id="studio-render-baseline" type="application/json">');
  const result = baseline < 0 ? html : html.slice(0, baseline);
  if (result.length > 4_000_000) {
    throw new Error('Preview render limit exceeded');
  }
  return result;
}

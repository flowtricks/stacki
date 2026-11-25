import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { pathFor } from '../project/previewSelection';
import { randomUUID } from 'node:crypto';
import type { ViteDevServer, WebSocketClient } from 'vite';
import { variantScope, type VariantOverride } from './variantRuntime';
import { parseVariantRequest, type VariantRequest } from './variantProtocol';
import { componentSchema } from '../components/componentSchema';
import { readSource } from '../project/projectServer';

// Tokens exist only for internal requests. No caller can provide an override in
// a page URL, and AsyncLocalStorage keeps concurrent editors' renders separate.
export function configureVariants(
  server: ViteDevServer,
  root: string,
  authorized: WeakSet<WebSocketClient['socket']>,
  render: (path: string, headers?: Record<string, string>) => Promise<string>,
  validPath: (input: unknown) => string | undefined,
) {
  const scopes = new Map<string, VariantOverride>();
  const jobs = new Map<WebSocketClient, VariantJob>();
  let running = 0;
  let revision = 0;
  installVariantScope(server, scopes);
  const renderVariant = variantRenderer(scopes, render);
  server.ws.on('studio:variants-prepare', (input: unknown, client: WebSocketClient) => {
    if (!authorized.has(client.socket)) {
      return;
    }
    let request: VariantRequest;
    try {
      request = parseVariantRequest(input);
    } catch {
      return;
    }
    if (!validPath(request)) {
      return;
    }
    if (running >= 4) {
      client.send('studio:variant-failed', { request: request.request });
      return;
    }
    const job: VariantJob = { request: request.request };
    const version = revision;
    jobs.set(client, job);
    running++;
    const current = () => version === revision && jobs.get(client) === job && client.socket.readyState === 1;
    void prepareVariants(
      root,
      request,
      render,
      renderVariant,
      (value, html) => sendVariant(client, request, value, html, current),
      current,
      () => job.priority,
    )
      .catch(() => {
        if (current()) {
          client.send('studio:variant-failed', { request: request.request });
        }
      })
      .finally(() => {
        running--;
        if (jobs.get(client) === job) {
          jobs.delete(client);
        }
      });
  });
  installVariantControls(server, jobs);
  return () => {
    revision++;
    jobs.clear();
    server.ws.send('studio:variants-invalidated', {});
  };
}

async function sendVariant(client: WebSocketClient, request: VariantRequest, value: string | number | null | undefined, html: string, current: () => boolean) {
  const encoded = request.gzip ? await encodeRenderedHTML(html) : { html };
  if (!current() || client.socket.bufferedAmount >= 8_000_000) {
    return;
  }
  client.send('studio:variant-render', {
    request: request.request,
    value,
    ...encoded,
  });
}

async function prepareVariants(
  root: string,
  request: VariantRequest,
  render: (path: string) => Promise<string>,
  renderVariant: (request: VariantRequest, value: string | number | null) => Promise<string>,
  send: (value: string | number | null | undefined, html: string) => Promise<void>,
  current: () => boolean,
  priority: () => string | number | null | undefined,
) {
  if ((await readSource(root, request.file)) !== request.source) {
    throw new Error('Draft changed');
  }
  const schema = await componentSchema(request.component, await readSource(root, request.component), (file) => readSource(root, file));
  const field = schema.find((field) => field.name === request.prop);
  if (
    !field?.options ||
    request.values.some((value) => value !== null && (!field.options?.includes(String(value)) || (typeof value === 'number') !== !!field.numeric))
  ) {
    throw new Error('Not an enum option');
  }
  let bytes = 0;
  // Baseline is also a real render, so cancel works without guessing classes or
  // reversing a DOM change. Rendering never touches the source or shared Y.Doc.
  const pending: (string | number | null | undefined)[] = [undefined, ...request.values];
  while (pending.length) {
    const preferred = pending[0] === undefined ? 0 : pending.indexOf(priority());
    const value = pending.splice(Math.max(0, preferred), 1)[0];
    if (!current()) {
      return;
    }
    const html = value === undefined ? await render(request.path) : await renderVariant(request, value);
    bytes += Buffer.byteLength(html);
    if (bytes > 16_000_000) {
      throw new Error('Variant cache limit exceeded');
    }
    if (current()) {
      await send(value, html);
    }
  }
}

function variantRenderer(scopes: Map<string, VariantOverride>, render: (path: string, headers?: Record<string, string>) => Promise<string>) {
  return async (request: VariantRequest, value: string | number | null) => {
    const token = randomUUID();
    scopes.set(token, {
      component: request.component,
      prop: request.prop,
      value,
      target: isCanvasPage(request.file) ? pathFor(request.node) : `${request.file}|${pathFor(request.node)}`,
    });
    try {
      return await render(request.path, { 'x-studio-variant': token });
    } finally {
      scopes.delete(token);
    }
  };
}

function installVariantScope(server: ViteDevServer, scopes: Map<string, VariantOverride>) {
  server.middlewares.use((request, _response, next) => {
    const token = request.headers['x-studio-variant'];
    const scope = typeof token === 'string' ? scopes.get(token) : undefined;
    if (scope) {
      variantScope.run(scope, next);
    } else {
      next();
    }
  });
}

interface VariantJob {
  readonly request: string;
  priority?: string | number | null;
}
function installVariantControls(server: ViteDevServer, jobs: Map<WebSocketClient, VariantJob>) {
  server.ws.on('studio:variants-cancel', (_input: unknown, client: WebSocketClient) => jobs.delete(client));
  server.ws.on('studio:variants-prioritize', (input: unknown, client: WebSocketClient) => {
    const job = jobs.get(client);
    if (!job || !input || typeof input !== 'object' || !('request' in input) || input.request !== job.request || !('value' in input)) {
      return;
    }
    const value = input.value;
    if (value === null || (typeof value === 'string' && value.length <= 500) || (typeof value === 'number' && Number.isFinite(value))) {
      job.priority = value;
    }
  });
}
import { encodeRenderedHTML } from './renderEncoding';

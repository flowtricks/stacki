import type { MiddlewareHandler } from 'astro';
import { renderBaselineScript } from './renderBaseline';
import { renderScope } from './renderRequest';

const MAX_RENDER_BYTES = 4_000_000;

// Keep the exact initial server rendering. A second request can already contain
// a collaborator's newer edit, making the first DOM patch incorrectly a no-op.
export const onRequest: MiddlewareHandler = async ({ request }, next) => {
  const response = await next();
  // Internal pushes already have an initial baseline in the browser. Streaming
  // their response directly avoids copying and JSON-escaping the entire page twice.
  if (renderScope.getStore() === 'patch') {
    return response;
  }
  if (request.method !== 'GET' || !response.headers.get('content-type')?.includes('text/html') || (!response.ok && response.status !== 404)) {
    return response;
  }
  // An authored 404 page is an editable HTML rendering, despite its status.
  return withRenderBaseline(response);
};

export async function withRenderBaseline(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_RENDER_BYTES) {
      await reader.cancel();
      return new Response('Studio preview exceeds the 4 MB rendering limit', { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const html = new TextDecoder().decode(bytes);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(html + renderBaselineScript(html), { status: response.status, headers });
}

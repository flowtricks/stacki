import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

// WebSocket HTML is otherwise sent uncompressed. Keep ordinary small replies
// simple; repetitive page markup benefits greatly from one gzip payload.
export async function encodeRenderedHTML(html: string): Promise<{ html: string } | { htmlGzip: string }> {
  if (html.length < 16_000) {
    return { html };
  }
  // Rendering and document collaboration share the Node event loop. Compression
  // belongs on zlib's worker pool so large canvases cannot block incoming edits.
  const compressed = (await compress(html, { level: 1 })).toString('base64');
  return compressed.length < html.length * 0.9 ? { htmlGzip: compressed } : { html };
}

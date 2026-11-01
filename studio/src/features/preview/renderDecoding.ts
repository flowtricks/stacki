const MAX_HTML = 4_000_000;
export async function decodeRenderedHTML(input: unknown): Promise<string | undefined> {
  if (!input || typeof input !== 'object') {
    return;
  }
  if ('html' in input && typeof input.html === 'string' && input.html.length <= MAX_HTML) {
    return input.html;
  }
  if (!('htmlGzip' in input) || typeof input.htmlGzip !== 'string' || input.htmlGzip.length > MAX_HTML || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.htmlGzip)) {
    return;
  }
  const bytes = Uint8Array.from(atob(input.htmlGzip), (character) => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_HTML) {
      await reader.cancel();
      throw new Error('Preview render exceeds the size limit');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
}

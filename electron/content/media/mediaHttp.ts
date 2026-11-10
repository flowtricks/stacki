// The HTTP the media stores share: one request with a deadline, a response
// body read up to a stated size and no further, and a host's refusal turned
// into a sentence the Assets panel can show.

import { assert } from '../../../shared/core/assert';

/** The platform fetch, injected so tests can play a host without a network. */
export type MediaFetch = (url: string, init: RequestInit) => Promise<Response>;

export const MEDIA_HTTP_LIMITS = {
  // A listing page, an error body or an order manifest; S3 pages of 1,000
  // keys are about 300 KB of XML.
  responseBytesMax: 8 * 1024 * 1024,
  // One uploaded, copied or downloaded file. Bigger media belongs in the
  // host's own uploader; reading it whole into memory here would not scale.
  fileBytesMax: 100 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  // A 100 MB transfer at a slow 1 MB/s, with room to spare.
  transferTimeoutMs: 5 * 60_000,
  errorCharsMax: 300,
} as const satisfies Record<string, number>;

/** A failure the host reported; its message is what the panel shows. */
export class MediaHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface MediaRequest {
  readonly method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
  readonly timeoutMs: number;
}

export async function send(fetcher: MediaFetch, request: MediaRequest): Promise<Response> {
  assert(request.timeoutMs > 0, 'A request has a deadline');
  assert(request.timeoutMs <= MEDIA_HTTP_LIMITS.transferTimeoutMs, 'A deadline is bounded');
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal: AbortSignal.timeout(request.timeoutMs),
    redirect: 'error',
    // A copy into an ArrayBuffer of exactly its length: a Node Buffer is often a
    // view into a larger shared pool, whose `.buffer` would send the whole pool.
    ...(request.body === undefined ? {} : { body: exactBuffer(request.body) }),
  };
  try {
    return await fetcher(request.url, init);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MediaHostError(`Could not reach ${new URL(request.url).host}: ${reason}`.slice(0, MEDIA_HTTP_LIMITS.errorCharsMax), 0);
  }
}

export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  assert(copy.buffer.byteLength === bytes.length, 'A request body is exactly its bytes');
  return copy.buffer;
}

/** The body, refused past `bytesMax` while it streams rather than after. */
export async function readBounded(response: Response, bytesMax: number): Promise<Uint8Array> {
  assert(bytesMax > 0, 'A body has a positive bound');
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > bytesMax) {
    await response.body?.cancel();
    throw new MediaHostError(`The host sent more than ${Math.floor(bytesMax / 1024 / 1024)} MB.`, response.status);
  }
  const stream = response.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Each chunk is at least one byte, so the body ends or passes its bound within bytesMax reads.
  for (let read = 0; read <= bytesMax; read++) {
    const next: unknown = await reader.read();
    const chunk = streamChunk(next);
    if (chunk === undefined) {
      break;
    }
    total += chunk.length;
    if (total > bytesMax) {
      await reader.cancel();
      throw new MediaHostError(`The host sent more than ${Math.floor(bytesMax / 1024 / 1024)} MB.`, response.status);
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  assert(offset === total, 'Every chunk is copied once');
  return body;
}

// One read of a byte stream: its chunk, or undefined once the stream is done.
function streamChunk(result: unknown): Uint8Array | undefined {
  if (typeof result !== 'object' || result === null) {
    throw new Error('A stream read is an object');
  }
  if (Reflect.get(result, 'done') === true) {
    return undefined;
  }
  const value: unknown = Reflect.get(result, 'value');
  if (!(value instanceof Uint8Array)) {
    throw new MediaHostError('The host sent a body that is not bytes.', 0);
  }
  return value;
}

export async function readText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readBounded(response, MEDIA_HTTP_LIMITS.responseBytesMax));
}

/** Throws the host's refusal unless the response succeeded; a 404 is allowed when asked. */
export async function expectOk(response: Response, describe: (status: number, body: string) => string): Promise<void> {
  if (response.ok) {
    return;
  }
  let body = '';
  try {
    body = await readText(response);
  } catch {
    // An unreadable error body still reports its status.
  }
  throw new MediaHostError(describe(response.status, body).slice(0, MEDIA_HTTP_LIMITS.errorCharsMax), response.status);
}

/** What a status means to the person, before the host's own words. */
export function statusSentence(status: number): string {
  if (status === 401 || status === 403) {
    return 'The host refused the keys. Check them, and that they may read and write this bucket.';
  }
  if (status === 404) {
    return 'The host has no such bucket, zone or file.';
  }
  if (status === 429) {
    return 'The host is limiting requests. Try again in a moment.';
  }
  if (status >= 500) {
    return `The host had a problem (${status}). Try again in a moment.`;
  }
  return `The host refused the request (${status}).`;
}

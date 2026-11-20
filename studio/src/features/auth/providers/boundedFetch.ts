// Goal: every request a provider makes to an identity service is bounded and its answer is parsed, never trusted.
// Bounds: a timeout, no redirects (a redirect could send a client secret elsewhere), and a response read in chunks and
// abandoned past a byte limit, so a hostile or broken endpoint cannot make the Worker buffer without end.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';

export const FETCH_LIMITS = {
  timeoutMs: 10_000,
  /** Discovery documents, key sets and token answers are a few kilobytes; this is generous. */
  bodyBytesMax: 65_536,
} as const satisfies Record<string, number>;

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export type FetchFailure = { readonly kind: 'network' } | { readonly kind: 'status'; readonly status: number } | { readonly kind: 'invalid' };

/** The platform `fetch`, looked up at call time so a test can replace it. */
export const platformFetch: Fetcher = (input, init) => fetch(input, init);

/** JSON from `url`, or why not. A non-2xx answer is a `status` failure whose JSON body (an OAuth error) is not read. */
export async function fetchJson(fetcher: Fetcher, url: string, init: RequestInit): Promise<Result<unknown, FetchFailure>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs) });
  } catch {
    return err({ kind: 'network' });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return err({ kind: 'status', status: response.status });
  }
  const text = await readBounded(response);
  if (text === undefined) {
    return err({ kind: 'invalid' });
  }
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err({ kind: 'invalid' });
  }
}

/** An OAuth error code (`invalid_grant`) from a non-2xx token answer, or undefined. Only the bounded code is returned. */
export async function oauthErrorCode(response: Response): Promise<string | undefined> {
  const text = await readBounded(response);
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    const code: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'error') : undefined;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

async function readBounded(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get('Content-Length') ?? '0');
  if (declared > FETCH_LIMITS.bodyBytesMax || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return response.body === null ? '' : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Bounded by the byte limit: each pass adds at least one byte or ends.
  for (let pass = 0; pass <= FETCH_LIMITS.bodyBytesMax + 1; pass++) {
    const step: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (step.done) {
      break;
    }
    const value: Uint8Array = step.value;
    total += value.length;
    if (total > FETCH_LIMITS.bodyBytesMax) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    return undefined;
  }
}

export { readBounded };

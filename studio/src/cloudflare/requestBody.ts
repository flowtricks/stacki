// A refusal reads what was sent first, up to a bound. Closing a connection with request bytes still
// unread makes Windows reset it, so the caller saw "fetch failed" instead of the 403 (Check on 010980b8
// and b6a4a679, Studio's Windows job, a refused POST in cloudflareStartup.test.ts).
export const REFUSED_BODY_BYTES_MAX = 1024 * 1024;

export async function discardBody(request: Pick<Request, 'body' | 'headers' | 'arrayBuffer'>): Promise<void> {
  if (request.body === null) {
    return;
  }
  // A declared length within the bound is read whole; anything else (too large, or streamed without
  // a length) is cancelled rather than read without a limit.
  const declaredBytes = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 && declaredBytes <= REFUSED_BODY_BYTES_MAX) {
    await request.arrayBuffer();
    return;
  }
  await request.body.cancel();
}

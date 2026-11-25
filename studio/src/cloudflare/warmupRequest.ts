// Waking compute must not execute an arbitrary homepage. The authenticated status
// route starts the container just as early, without competing with the real preview.
export function warmupRequest(request: Request, previewOrigin: string): Request | undefined {
  if (request.method !== 'GET') {
    return undefined;
  }
  if (!['/studio', '/studio/'].includes(new URL(request.url).pathname)) {
    return undefined;
  }
  return new Request(new URL('/studio/api/status', previewOrigin), request);
}

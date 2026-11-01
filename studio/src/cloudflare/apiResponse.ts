export function isStudioAPI(request: Request) {
  return new URL(request.url).pathname.startsWith('/studio/api/');
}
export function studioError(request: Request, message: string, status: number) {
  const headers = { 'Cache-Control': 'no-store' };
  return isStudioAPI(request) ? Response.json({ error: message }, { status, headers }) : new Response(message, { status, headers });
}

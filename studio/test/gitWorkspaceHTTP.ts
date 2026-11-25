// Goal: exercise the real Git routes and collaboration coordinator over HTTP.
// Method: bind an ephemeral loopback listener backed by a disposable local origin.
import { createServer } from 'node:http';
import { gitWorkspaceRoutes } from '../src/features/history/gitWorkspaceRoutes';
import { withGitWorkspaceLease, isGitWorkspaceRead } from '../src/features/history/gitWorkspaceLease';
import { createRooms } from '../src/features/collaboration/rooms';
import type { PublishConnection } from '../src/shared/publishConnection';

export async function startGitWorkspaceHTTP(root: string, connection: PublishConnection) {
  const rooms = createRooms(root);
  const route = gitWorkspaceRoutes(root, { historyConnection: async () => ({ ok: true, value: connection }) }, rooms, () => false);
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk) || body.length + chunk.length > 1_000_000) {
          throw new Error('Invalid test request.');
        }
        body += chunk.toString('utf8');
      }
      const expected = request.headers['x-studio-workspace'];
      const work = () => route(request, response, new URL(request.url ?? '/', 'http://local').pathname, async () => body);
      if (isGitWorkspaceRead(new URL(request.url ?? '/', 'http://local').pathname)) {
        await work();
      } else {
        await withGitWorkspaceLease(root, typeof expected === 'string' ? expected : undefined, work);
      }
    })().catch((error: unknown) => {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing Git fixture port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    rooms,
    async stop() {
      await rooms.resetWorkspace();
      rooms.sockets.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

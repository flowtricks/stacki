import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { createAstroFileMonitor } from '../../../vendor/stacki/electron/project/astroFileMonitor';
import { MEDIA_EXT } from '../assets/assetStateTypes';

// A dedicated event stream works without a canvas and keeps the site's Vite error overlay
// out of the editor. Active sessions recheck access without interrupting file notifications.
export function createAstroNotifications(server: ViteDevServer, root: string) {
  const clients = new Set<ServerResponse>();
  const monitor = createAstroFileMonitor(root, (changes) => {
    const event = `data: ${JSON.stringify(changes)}\n\n`;
    for (const client of clients) {
      if (!client.write(event)) {
        client.end();
        clients.delete(client);
      }
    }
  });
  const projectUpdates = createProjectUpdates(clients, root);
  const changed = (event: string, file: string) => {
    projectUpdates.changed(event, file);
    if (['add', 'unlink', 'addDir', 'unlinkDir'].includes(event)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (relative === 'src' || relative.startsWith('src/')) {
        monitor.request();
      }
    }
  };
  server.watcher.on('all', changed);
  server.httpServer?.once('close', () => {
    monitor.close();
    projectUpdates.close();
    server.watcher.off('all', changed);
    for (const client of clients) {
      client.end();
    }
    clients.clear();
  });
  return (response: ServerResponse, authorize?: () => Promise<boolean>) => subscribe(clients, response, authorize);
}

function createProjectUpdates(clients: ReadonlySet<ServerResponse>, root: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let assetsChanged = false;
  return {
    changed: (event: string, file: string) => {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!/^(src|public)(\/|$)/.test(relative)) {
        return;
      }
      // Source edits do not change the asset catalog. Rescanning it for every
      // keystroke or drag competes with rendering for every connected editor.
      assetsChanged ||= MEDIA_EXT.test(relative) || event === 'addDir' || event === 'unlinkDir';
      if (timer !== undefined) {
        return;
      }
      // One notification per burst also covers Markdown, collections, assets and empty folders.
      timer = setTimeout(() => {
        timer = undefined;
        const events = 'event: project-changed\ndata: {}\n\n' + (assetsChanged ? 'event: assets-changed\ndata: {}\n\n' : '');
        assetsChanged = false;
        for (const client of clients) {
          if (!client.write(events)) {
            client.end();
          }
        }
      }, 200);
    },
    close: () => clearTimeout(timer),
  };
}

function subscribe(clients: Set<ServerResponse>, response: ServerResponse, authorize?: () => Promise<boolean>) {
  if (clients.size >= 100) {
    response.writeHead(503);
    response.end('Too many notification connections');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 1000\n\n');
  clients.add(response);
  const lease = authorize
    ? setInterval(() => {
        void authorize()
          .then((allowed) => {
            if (!allowed) {
              response.end();
            }
          })
          .catch(() => response.end());
      }, 60_000)
    : undefined;
  const heartbeat = setInterval(() => {
    if (!response.write(': keepalive\n\n')) {
      response.end();
    }
  }, 15_000);
  response.once('close', () => {
    clearInterval(lease);
    clearInterval(heartbeat);
    clients.delete(response);
  });
}

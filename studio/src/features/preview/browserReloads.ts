import type { HMRPayload, ViteDevServer } from 'vite';

export function interceptBrowserReloads(server: ViteDevServer, render: () => void): void {
  // Only browser reloads become canvas patches. Server environment reloads clear
  // evaluated modules; swallowing those leaves Vite running obsolete module state.
  const send = server.ws.send.bind(server.ws);
  server.ws.send = (payload: HMRPayload | string, data?: unknown) => {
    if (typeof payload === 'string') {
      send(payload, data);
    } else if (payload.type === 'full-reload') {
      render();
      send({ type: 'custom', event: 'avb:page-changed' });
    } else {
      send(payload);
    }
  };
}

// Code intelligence's IPC (docs/contracts.md, "Code intelligence"): a question about a file of the open project goes to
// the intelligence process (electron/lib/codeIntel/host.ts). Only the open project is answered.
import { UNAVAILABLE } from '../../shared/ipc/codeIntel';
import { createIntelHost, type IntelChild, type IntelHost } from '../lib/codeIntel/host';
import { explorerRoot } from '../project/explorerPaths';
import type { MainHost } from './mainHost';

export function registerCodeIntelHandlers(host: Pick<MainHost, 'ipcMain' | 'openProject'>, options: { readonly spawn: () => IntelChild }): IntelHost {
  const intel = createIntelHost({
    spawn: options.spawn,
    now: Date.now,
    setTimer: (action, delayMs) => {
      const handle = setTimeout(action, delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
    log: (message) => console.error(message),
  });
  host.ipcMain.handle('codeIntel:request', (_event, request) => {
    const root = explorerRoot(request.projectPath, host.openProject());
    return root.ok ? intel.request({ ...request, projectPath: root.value.lexical }) : UNAVAILABLE;
  });
  return intel;
}

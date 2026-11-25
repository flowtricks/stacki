// The renderer's side of `dev:network` and `dev:setNetwork` (shared/ipc/devNetwork.ts): the request is
// parsed before it is sent and every reply before a component sees it.
import { parseIpcPayload } from '../../../../shared/ipc/ipcPayloads';
import { parseDevNetworkReply, parseDevNetworkState, type DevNetworkMode, type DevNetworkReply, type DevNetworkState } from '../../../../shared/ipc/devNetwork';

/** Whether this project's preview is open on the local network right now, as main holds it. */
export function readDevNetwork(projectPath: string): Promise<DevNetworkState> {
  const payload = parseIpcPayload('dev:network', projectPath);
  return window.avb.devNetwork(payload).then(parseDevNetworkState);
}

/** Restarts the project's preview on the local network or on this computer only; the reply is the new state or why not. */
export function changeDevNetwork(projectPath: string, mode: DevNetworkMode): Promise<DevNetworkReply> {
  const payload = parseIpcPayload('dev:setNetwork', { projectPath, mode });
  return window.avb.setDevNetwork(payload).then(parseDevNetworkReply);
}

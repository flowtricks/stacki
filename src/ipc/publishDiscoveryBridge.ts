import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parsePublishDiscovery, type DiscoveryRequest } from '../../shared/properties/publishDiscovery';

export async function discoverPublishing(projectPath: string, request: DiscoveryRequest) {
  const input = parseIpcPayload('publish:discover', { projectPath, request });
  return parsePublishDiscovery(await window.avb.discoverPublishing(input));
}

import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseNetlifySiteResult, type NetlifySiteRequest, type NetlifySiteResult } from '../../shared/properties/publishNetlify';

// Desktop creates a Netlify site in main; Studio replaces this module with its HTTP client.
export async function createPublishNetlifySite(projectPath: string, site: NetlifySiteRequest): Promise<NetlifySiteResult> {
  const input = parseIpcPayload('publish:netlifySite', { projectPath, site });
  return parseNetlifySiteResult(await window.avb.createNetlifySite(input));
}

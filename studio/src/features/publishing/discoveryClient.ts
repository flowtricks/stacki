import { parseDiscoveryRequest, parsePublishDiscovery, type DiscoveryRequest } from '../../../vendor/stacki/shared/properties/publishDiscovery';
import { request } from '../project/projectClient';

export async function discoverPublishing(_project: string, input: DiscoveryRequest) {
  return parsePublishDiscovery(
    await request('/studio/api/publish/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parseDiscoveryRequest(input)),
    }),
  );
}

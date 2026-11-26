import {
  parseNetlifySiteRequest,
  parseNetlifySiteResult,
  type NetlifySiteRequest,
  type NetlifySiteResult,
} from '../../../vendor/stacki/shared/properties/publishNetlify';
import { request } from '../project/projectClient';

// Studio's stand-in for Desktop's Netlify bridge: the same request and result, over HTTP to the Studio server.
export async function createPublishNetlifySite(_project: string, site: NetlifySiteRequest): Promise<NetlifySiteResult> {
  return parseNetlifySiteResult(
    await request('/studio/api/publish/netlify-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parseNetlifySiteRequest(site)),
    }),
  );
}

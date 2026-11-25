import type { IncomingMessage, ServerResponse } from 'node:http';
import { publishedProjectSiteURL } from '../../../vendor/stacki/electron/project/publishSite';
import { parsePublishSource, type Hosting } from '../../../vendor/stacki/shared/properties/publishConfig';
import { parsePublishedSiteURL } from '../../../vendor/stacki/shared/properties/publishSite';
import { readMetadataSource } from '../settings/projectMetadata';
import { managedHostingFromEnvironment } from './managedHosting';

export async function siteRoute(root: string, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/studio/api/publish/site-url') {
    return false;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return true;
  }
  const metadata = await readMetadataSource(root, 'publish');
  const config = parsePublishSource(metadata.source);
  const managed = managedSiteURL(config.hosting, managedHostingFromEnvironment(), process.env['STUDIO_DEPLOYMENT_URL']);
  // Managed builds already know the public domain. Discover other destinations
  // with the same provider service as Desktop, without requiring it for this link.
  const url = managed ?? (await publishedProjectSiteURL(root, metadata.source).catch(() => undefined));
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ url }));
  return true;
}

export function managedSiteURL(selected: Hosting, managed: Hosting | undefined, endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  if (selected.provider !== 'none') {
    if (selected.provider !== 'cloudflare-workers' || managed?.provider !== 'cloudflare-workers') {
      return undefined;
    }
    if (selected.accountId !== managed.accountId || selected.project !== managed.project) {
      return undefined;
    }
  }
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new Error('Published site endpoint cannot contain credentials.');
  }
  return parsePublishedSiteURL(url.origin);
}

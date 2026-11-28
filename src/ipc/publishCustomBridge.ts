import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseCustomPublishResult, type CustomPublishRequest, type CustomPublishResult } from '../../shared/properties/publishDeployLink';

/** Desktop publishes to added destinations. Studio's replacement of this module says it does not, and the screens leave them out. */
export const DESTINATION_SUPPORT: boolean = true;

// Desktop reads the site's script names and keeps deploy links in main; Studio replaces this module with its HTTP client.
export async function publishingCustomHost(projectPath: string, request: CustomPublishRequest): Promise<CustomPublishResult> {
  const input = parseIpcPayload('publish:custom', { projectPath, request });
  return parseCustomPublishResult(await window.avb.publishingCustomHost(input));
}

import {
  parseCustomPublishRequest,
  parseCustomPublishResult,
  type CustomPublishRequest,
  type CustomPublishResult,
} from '../../../vendor/stacki/shared/properties/publishDeployLink';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { request as studioRequest } from '../project/projectClient';

/** Staging publishes from Desktop only, so the shared screens leave its controls out in Studio. */
export const STAGING_SUPPORT: boolean = false;

// Studio's stand-in for Desktop's custom host bridge. It only reads: Studio keeps no deploy links, so a request
// to save or remove one is answered here and the link is never sent to the server.
export async function publishingCustomHost(_project: string, input: CustomPublishRequest): Promise<CustomPublishResult> {
  if (parseCustomPublishRequest(input).action !== 'read') {
    return { kind: 'failed', ...described('publish.custom.link.studio') };
  }
  return parseCustomPublishResult(await studioRequest('/studio/api/publish/custom'));
}

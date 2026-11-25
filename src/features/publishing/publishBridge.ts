import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { PublishTarget } from '../../../shared/properties/publishConfig';
import { parseDesktopPublishState } from '../../../shared/properties/publishState';
import { parsePublishAvailability, type PublishAvailability } from '../../../shared/properties/publishState';
import type { Result } from '../../../shared/core/result';
import { parsePublishedSiteURL } from '../../../shared/properties/publishSite';
import { publishedSiteURL } from '../../ipc/publishSiteHost';

export async function readPublishedSiteURL(projectPath: string): Promise<string | undefined> {
  const input = parseIpcPayload('publish:siteURL', projectPath);
  let response: unknown;
  try {
    response = await publishedSiteURL(input);
  } catch {
    return undefined;
  }
  return response === undefined ? undefined : parsePublishedSiteURL(response);
}

export async function readPublishAvailability(projectPath: string): Promise<Result<PublishAvailability, string>> {
  const input = parseIpcPayload('publish:availability', projectPath);
  let response: unknown;
  try {
    response = await window.avb.publishAvailability(input);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Contract violations stay loud; only a transport failure means unavailable status.
  return { ok: true, value: parsePublishAvailability(response) };
}

export async function startPublish(projectPath: string, target: PublishTarget, commitMessage?: string) {
  const input = parseIpcPayload('publish:start', { projectPath, target, commitMessage });
  return parseDesktopPublishState(await window.avb.publishStart(input));
}

export async function readPublishState(projectPath: string) {
  const input = parseIpcPayload('publish:state', projectPath);
  return parseDesktopPublishState(await window.avb.publishState(input));
}

// The template form's calls into the main process, each reply parsed before a
// component sees it. A secret passes through here once, on its way to .env.

import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseRemoteResult, type RemoteResult } from '../../shared/properties/cmsRemote';
import {
  parseDataSample,
  parsePageTemplateCreated,
  parsePageTemplatePlan,
  type ConnectionKeyCopy,
  type DataSample,
  type DataSampleRequest,
  type PageTemplateDraft,
  type PageTemplatePlan,
} from '../../shared/properties/pageTemplate';

export async function sampleDataSource(projectPath: string, request: DataSampleRequest): Promise<RemoteResult<DataSample>> {
  const payload = parseIpcPayload('pageTemplate:sample', { projectPath, request });
  return parseRemoteResult(await window.avb.sampleDataSource(payload), parseDataSample);
}

export async function planPageTemplate(projectPath: string, draft: PageTemplateDraft): Promise<RemoteResult<PageTemplatePlan>> {
  const payload = parseIpcPayload('pageTemplate:plan', { projectPath, draft });
  return parseRemoteResult(await window.avb.planPageTemplate(payload), parsePageTemplatePlan);
}

export async function createPageTemplate(
  projectPath: string,
  draft: PageTemplateDraft,
  devUrl: string | undefined,
  keyCopy: ConnectionKeyCopy | undefined,
): Promise<RemoteResult<{ readonly pagePath: string }>> {
  const payload = parseIpcPayload('pageTemplate:create', { projectPath, draft, devUrl, keyCopy });
  return parseRemoteResult(await window.avb.createPageTemplate(payload), parsePageTemplateCreated);
}

export async function setProjectEnv(projectPath: string, name: string, value: string): Promise<RemoteResult<void>> {
  const payload = parseIpcPayload('project:setEnv', { projectPath, name, value });
  return parseRemoteResult(await window.avb.setProjectEnv(payload), () => undefined);
}

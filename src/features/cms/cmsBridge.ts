import { cmsTransport } from '../../ipc/editorEnvironment';
import type { Result } from '../../../shared/core/result';
import type { Parser } from '../../../shared/core/boundary';
import type { DeclaredTypes } from './cmsTypes';
import { boolean, data, dictionary, list, object, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cleanError } from '../../lib/cleanError';
import { parseDeclaredTypes } from './cmsTypes';

export function parseCmsRead(input: unknown) {
  const value = record(input);
  if (!Object.hasOwn(value, 'data')) {
    throw new Error('CMS read: missing data');
  }
  return { data: data(value['data']) };
}
export const parseCmsMeta = object({ meta: dictionary(parseDeclaredTypes) });
export const parseCmsUsage = object({ files: list(pathText) });
export function parseCmsSuccess(input: unknown): void {
  const value = record(input);
  if (!boolean(value['ok'])) {
    throw new Error('CMS result: expected success');
  }
}
export function parseCmsAsset(input: unknown) {
  const value = record(input);
  if (value['value'] !== undefined) {
    return text(value['value']);
  }
  return { __expr: text(value['name']), __asset: pathText(value['asset']) };
}
async function cmsRequest<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  // A broken contract is not a disk failure. Parse outside the operating-error catch.
  return { ok: true, value: parse(response) };
}
export function readCms(projectPath: string, rel: string) {
  const payload = parseIpcPayload('cms:read', { projectPath, rel });
  return cmsRequest(parseCmsRead, () => cmsTransport.readCms(payload));
}
export function readCmsMeta(projectPath: string) {
  const payload = parseIpcPayload('cms:meta', projectPath);
  return cmsRequest(parseCmsMeta, () => cmsTransport.cmsMeta(payload));
}
export function writeCms(projectPath: string, rel: string, value: unknown, expectedData?: unknown) {
  const payload = parseIpcPayload('cms:write', { projectPath, rel, data: value });
  return cmsRequest(parseCmsSuccess, () => cmsTransport.writeCms(payload, expectedData));
}
export function writeCmsMeta(projectPath: string, rel: string, fields: DeclaredTypes) {
  const payload = parseIpcPayload('cms:setMeta', { projectPath, rel, fields });
  return cmsRequest(parseCmsSuccess, () => cmsTransport.setCmsMeta(payload));
}
export function readCmsUsage(projectPath: string, rel: string) {
  const payload = parseIpcPayload('cms:usage', { projectPath, rel });
  return cmsRequest(parseCmsUsage, () => cmsTransport.cmsUsage(payload));
}
export function deleteCms(projectPath: string, rel: string) {
  const payload = parseIpcPayload('cms:delete', { projectPath, rel });
  return cmsRequest(
    (response) => {
      parseCmsSuccess(response);
      return list(pathText)(record(response)['rewritten']);
    },
    () => cmsTransport.deleteCms(payload),
  );
}
export function importCmsAsset(projectPath: string, rel: string, assetRel: string) {
  const payload = parseIpcPayload('cms:assetRef', { projectPath, rel, assetRel });
  return cmsRequest(parseCmsAsset, () => cmsTransport.cmsAssetRef(payload));
}

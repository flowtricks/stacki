import { SerialQueue } from '../../shared/serialQueue';
import { request } from '../project/projectClient';
import { record, sourcePath, string } from '../../shared/validation';
const requests = new SerialQueue();
const entryVersions = new Map<string, Readonly<Record<string, string>>>();
const versions = new Map<string, Readonly<Record<string, string>>>();
const mutations = new Set([
  'cms:write',
  'cms:create',
  'cms:setMeta',
  'cms:delete',
  'cms:assetRef',
  'content:writeEntry',
  'content:rename',
  'content:remoteEdit',
]);
function keyOf(operation: string, payload: unknown) {
  // A content collection's reads and edits share one key: the versions a read
  // returns are the ones the next edit is checked against.
  if (operation === 'content:remoteRead' || operation === 'content:remoteEdit') {
    return 'content:remote';
  }
  const input = typeof payload === 'string' ? {} : record(payload);
  if (operation === 'cms:meta' || operation === 'cms:setMeta') {
    return 'meta';
  }
  if (input['entry']) {
    return string(record(input['entry'])['file'], 500);
  }
  return String(input['rel'] ?? input['name'] ?? operation);
}
export function cmsRequest(operation: string, payload: unknown, expectedData?: unknown) {
  return requests.run(() => performRequest(operation, payload, expectedData));
}
async function performRequest(operation: string, payload: unknown, expectedData?: unknown) {
  const key = keyOf(operation, payload);
  const result = record(
    await request('/studio/api/cms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation,
        payload,
        versions: (operation === 'content:writeEntry' ? entryVersions : versions).get(key) ?? {},
        ...(expectedData === undefined ? {} : { expectedData }),
      }),
    }),
  );
  const incoming = record(result['versions']);
  if (Object.keys(incoming).length > 2000) {
    throw new Error('CMS version limit exceeded');
  }
  const revision = Object.fromEntries(Object.entries(incoming).map(([file, hash]) => [sourcePath(file), string(hash, 64)]));
  if (operation === 'content:writeEntry') {
    const hash = revision[key];
    if (hash) {
      entryVersions.set(key, { [key]: hash });
    }
  } else {
    versions.set(key, revision);
  }
  if (versions.size > 100) {
    const oldest = versions.keys().next().value;
    if (oldest) {
      versions.delete(oldest);
    }
  }
  if (operation === 'content:entries') {
    const entries: unknown = record(result['value'])['entries'];
    if (Array.isArray(entries) && entries.length <= 10000) {
      for (const entry of entries) {
        const file = sourcePath(record(entry)['file']);
        const hash = revision[file];
        if (hash) {
          entryVersions.set(file, { [file]: hash });
        }
      }
    }
  }
  for (const file of [...entryVersions.keys()].slice(0, Math.max(0, entryVersions.size - 2000))) {
    entryVersions.delete(file);
  }
  if (mutations.has(operation)) {
    window.dispatchEvent(new Event('studio:source-updated'));
  }
  return result['value'];
}
export function onCmsChanged(callback: () => void) {
  window.addEventListener('studio:source-updated', callback);
  return () => window.removeEventListener('studio:source-updated', callback);
}
const invoke = (operation: string) => (payload: unknown) => cmsRequest(operation, payload);
export const cmsTransport = {
  onCmsChanged,
  listCms: invoke('cms:list'),
  readCms: invoke('cms:read'),
  cmsMeta: invoke('cms:meta'),
  writeCms: (payload: unknown, expectedData?: unknown) => cmsRequest('cms:write', payload, expectedData),
  createCms: invoke('cms:create'),
  setCmsMeta: invoke('cms:setMeta'),
  cmsUsage: invoke('cms:usage'),
  deleteCms: invoke('cms:delete'),
  cmsAssetRef: invoke('cms:assetRef'),
  contentCollections: invoke('content:collections'),
  contentEntries: invoke('content:entries'),
  contentRemoteRead: invoke('content:remoteRead'),
  contentRemoteEdit: invoke('content:remoteEdit'),
  contentTargets: invoke('content:targets'),
  writeContentEntry: (payload: unknown, expected?: unknown) => cmsRequest('content:writeEntry', payload, expected),
  validateContentEntry: invoke('content:validate'),
  contentRenamePlan: invoke('content:renamePlan'),
  renameContentEntry: invoke('content:rename'),
};

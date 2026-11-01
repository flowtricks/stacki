import { checkContentExpected } from './cmsExpected';
import { withCmsDeletions } from './cmsDeleted';
import { validateCmsPayload } from './cmsPaths';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createRooms } from '../collaboration/rooms';
import { record, string } from '../../shared/validation';
import { cmsHandlers } from './cmsHost';
import { cmsSources, withCmsSnapshot, CmsReadWorkspace } from './cmsSnapshot';
import { cmsVersions, commitCms } from './cmsCommit';

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
export function cmsRoutes(root: string, rooms: ReturnType<typeof createRooms>) {
  const handlers = cmsHandlers();
  const reads = new CmsReadWorkspace(root);
  rooms.sockets.once('close', () => {
    void reads.close().catch((error: unknown) => console.error('CMS cleanup failed', error));
  });
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    readBody: () => Promise<string>,
  ) => {
    if (pathname !== '/studio/api/cms') {
      return false;
    }
    if (request.method !== 'POST') {
      throw new Error('Use POST for CMS operations');
    }
    const input = record(JSON.parse(await readBody()));
    const operation = string(input['operation'], 50);
    if (typeof input['payload'] !== 'string') {
      validateCmsPayload(operation, record(input['payload']));
    }
    const handler = handlers.get(operation);
    if (
      !handler ||
      (!operation.startsWith('cms:') && !operation.startsWith('content:')) ||
      operation === 'content:sampleEntry'
    ) {
      throw new Error('Unknown CMS operation');
    }
    // Only capture needs a consistent project revision. Inspecting an immutable
    // staging directory must not queue edits and heartbeat replies behind CMS reads.
    const run = async (snapshot: Awaited<ReturnType<typeof cmsSources>>) => {
      const execute = async (stage: string) => {
        const payload =
          typeof input['payload'] === 'string'
            ? stage
            : { ...record(input['payload']), projectPath: stage };
        if (input['expectedData'] !== undefined && operation === 'content:writeEntry') {
          checkContentExpected(snapshot.sources, payload, input['expectedData']);
        }
        if (input['expectedData'] !== undefined && operation === 'cms:write') {
          const read = handlers.get('cms:read');
          const current = record(await read?.(payload));
          if (JSON.stringify(current['data']) !== JSON.stringify(input['expectedData'])) {
            throw new Error(
              'A collaborator changed this collection. Undo cannot replace newer content.',
            );
          }
        }
        const value = await handler(payload);
        if (!mutations.has(operation)) {
          return { value, versions: cmsVersions(snapshot.sources) };
        }
        const after = await cmsSources(stage);
        const next = withCmsDeletions(snapshot.sources, after.sources);
        await commitCms(root, rooms, snapshot.sources, next, record(input['versions']));
        return { value, versions: cmsVersions(next) };
      };
      return mutations.has(operation)
        ? withCmsSnapshot(root, snapshot, execute)
        : reads.read(snapshot, execute);
    };
    const result = mutations.has(operation)
      ? await rooms.coordinator.run(async () => run(await cmsSources(root, rooms)))
      : await run(await rooms.coordinator.run(() => cmsSources(root, rooms)));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
    return true;
  };
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readVariables } from '../../../vendor/stacki/electron/project/cssVarModel';
import { checksum, type createRooms } from '../collaboration/rooms';
import { readSource, walk } from '../project/projectServer';
import { record, string } from '../../shared/validation';
import { applyVariableOperation } from './variableOperations';
import { VARIABLE_ROOT, withVariableWorkspace } from './variableWorkspace';
import { batchedRead } from '../../shared/batchedRead';

type Rooms = ReturnType<typeof createRooms>;
export function variableRoutes(root: string, rooms: Rooms) {
  const read = cachedVariableReader();
  return async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>) => {
    if (pathname !== '/studio/api/variables') {
      return false;
    }
    const input = request.method === 'POST' ? record(JSON.parse(await readBody())) : undefined;
    if (request.method !== 'GET' && request.method !== 'POST') {
      throw new Error('Use GET or POST for variables');
    }
    const result = await rooms.coordinator.run(async () => {
      const before = await variableSources(root, rooms);
      if (!input) {
        return read(before);
      }
      return editVariables(rooms, before, input);
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
    return true;
  };
}
/** The Variables route's read, for a bake, where no room exists to read through. */
export async function scanProjectVariables(root: string) {
  const sources = await variableSources(root, { read: (file) => readSource(root, file) });
  const versions = Object.fromEntries([...sources].map(([file, text]) => [file, checksum(text)]));
  return readVariableSnapshot(sources, versions);
}
function cachedVariableReader() {
  let cached: { readonly signature: string; readonly value: ReturnType<typeof readVariableSnapshot> } | undefined;
  return (sources: Map<string, string>) => {
    const versions = Object.fromEntries([...sources].map(([file, text]) => [file, checksum(text)]));
    const signature = JSON.stringify(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)));
    if (cached?.signature !== signature) {
      cached = { signature, value: readVariableSnapshot(sources, versions) };
    }
    return cached.value;
  };
}
function readVariableSnapshot(sources: Map<string, string>, versions: Readonly<Record<string, string>>) {
  return withVariableWorkspace(sources, () => ({ ...readVariables(VARIABLE_ROOT), versions }));
}
async function variableSources(root: string, rooms: Pick<Rooms, 'read'>) {
  const paths = [...(await walk(root, 'src')), ...(await walk(root, 'public'))].filter((file) => /\.(astro|md|mdx|css|ts|js)$/.test(file));
  if (paths.length > 1000) {
    throw new Error('Variable scan exceeds 1,000 source files');
  }
  let total = 0;
  const entries = await batchedRead(paths, async (file) => {
    const text = await rooms.read(file);
    total += Buffer.byteLength(text);
    if (total > 32_000_000) {
      throw new Error('Variable scan exceeds 32 MB');
    }
    return [file, text] as const;
  });
  return new Map(entries);
}
async function editVariables(rooms: Rooms, before: Map<string, string>, input: Record<string, unknown>) {
  const next = new Map(before);
  const result = withVariableWorkspace(next, () => applyVariableOperation(string(input['operation'], 50), input['payload']));
  if (!result.ok) {
    return result;
  }
  const versions = record(input['versions']);
  const changed = [...next].filter(([file, text]) => before.get(file) !== text);
  // Check every file before committing any of a multi-file rename or mode edit.
  for (const [file] of changed) {
    if (input['operation'] !== 'restoreCssVariables' && versions[file] !== checksum(before.get(file) ?? '')) {
      return { ok: false, error: 'A collaborator changed this source. Refresh and try again.' };
    }
  }
  const targets = await Promise.all(changed.map(async ([file, text]) => ({ room: await rooms.get(file), text })));
  for (const { room, text } of targets) {
    await room.setSource(text);
  }
  return { ok: true };
}

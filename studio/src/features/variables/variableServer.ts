import type { IncomingMessage, ServerResponse } from 'node:http';
import { readVariables } from '../../../vendor/stacki/electron/project/cssVarModel';
import { checksum, type createRooms } from '../collaboration/rooms';
import { editableSource, readListedSource, readSource, supportedPath, walk } from '../project/projectServer';
import { MAX_SOURCE, record, string } from '../../shared/validation';
import { applyVariableOperation } from './variableOperations';
import { VARIABLE_ROOT, withVariableWorkspace } from './variableWorkspace';
import { batchedRead } from '../../shared/batchedRead';
import { readMetadataSource } from '../settings/projectMetadata';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { requestRole } from '../roles/serverAccess';
import { assertRoleWrite } from '../roles/writeRules';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { METADATA_FILES } from '../../../vendor/stacki/shared/properties/projectMetadata';

type Rooms = ReturnType<typeof createRooms>;
const SCAN_BYTES_MAX = 32_000_000;
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
      return editVariables(rooms, before, input, await requestRole(root, request));
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
    // A file Studio cannot edit is still read: left out, a rename would miss its references without a word.
    const text = (await editableSource(root, file)) ? await rooms.read(file) : await readListedSource(root, file, SCAN_BYTES_MAX);
    total += Buffer.byteLength(text);
    if (total > SCAN_BYTES_MAX) {
      throw new Error('Variable scan exceeds 32 MB');
    }
    return [file, text] as const;
  });
  // The variables folders decide which stylesheets the variables panel reads (cssVarRead.ts); the
  // snapshot carries them so the synchronous reader sees the same settings as the disk.
  const folders = await readMetadataSource(root, 'folders');
  return new Map(folders.source === undefined ? entries : [...entries, [METADATA_FILES.folders, folders.source] as const]);
}
async function editVariables(rooms: Rooms, before: Map<string, string>, input: Record<string, unknown>, role: RoleView) {
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
      const changed = described('variables.error.collaboratorChanged');
      return { ok: false, error: changed.message, errorRef: changed.messageRef };
    }
  }
  // All or nothing: an edit that reaches a file Studio cannot write is refused whole.
  const locked = changed.find(([file, text]) => !supportedPath(file) || Math.max(text.length, Buffer.byteLength(before.get(file) ?? '')) > MAX_SOURCE);
  if (locked !== undefined) {
    const refused = described('variables.error.fileNotEditable', { file: locked[0] });
    return { ok: false, error: refused.message, errorRef: refused.messageRef };
  }
  await assertVariableWrites(rooms, role, before, changed);
  const targets = await Promise.all(changed.map(async ([file, text]) => ({ room: await rooms.get(file), text })));
  for (const { room, text } of targets) {
    await room.setSource(text);
  }
  return { ok: true };
}

// A variable edit rewrites its name wherever it is read, scripts included. A rename alone changes no code; anything
// else a role without code permission writes here answers to the code check.
async function assertVariableWrites(rooms: Rooms, role: RoleView, before: ReadonlyMap<string, string>, changed: readonly (readonly [string, string])[]) {
  const unnamed = (text: string) => text.replace(/--[\w-]+/g, '--variable');
  for (const [file, text] of changed) {
    const original = before.get(file);
    if (original === undefined || unnamed(original) !== unnamed(text)) {
      await assertRoleWrite(role, { file, before: original, after: text }, rooms.guard);
    }
  }
}

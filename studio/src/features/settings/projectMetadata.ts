import { writeFile, stat } from 'node:fs/promises';
import {
  METADATA_FILES,
  metadataKind,
  metadataSource,
  parseMetadataWrite,
  validateMetadata,
  type MetadataKind,
} from '../../../vendor/stacki/shared/properties/projectMetadata';
import { readSource, preparePath, safePath } from '../project/projectServer';
import type { createRooms } from '../collaboration/rooms';
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readMetadataSource(root: string, kind: MetadataKind) {
  const file = METADATA_FILES[kind];
  try {
    await stat(await safePath(root, file));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  return { source: metadataSource(await readSource(root, file)) };
}

/** Enumerate only shared files; a preview checkout is never part of a metadata scan. */
export async function metadataFiles(root: string): Promise<readonly string[]> {
  const kinds: readonly MetadataKind[] = [
    'components',
    'guide',
    'publish',
    'pages',
    'componentSources',
    'styles',
    'folders',
    'roles',
    'instructions',
    'audits',
    'variables',
  ];
  const files = await Promise.all(
    kinds.map(async (kind) => {
      const stored = await readMetadataSource(root, kind);
      return stored.source === undefined ? [] : [METADATA_FILES[kind]];
    }),
  );
  return files.flat();
}

export async function metadataRoute(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/metadata') {
    return false;
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    throw new Error('Use GET or POST for project settings');
  }
  const result =
    request.method === 'GET'
      ? await readMetadataSource(root, metadataKind(new URL(request.url ?? '/', 'http://studio').searchParams.get('kind')))
      : await saveMetadata(root, rooms, JSON.parse(await readBody()));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(result));
  return true;
}

async function saveMetadata(root: string, rooms: ReturnType<typeof createRooms>, value: unknown) {
  const input = parseMetadataWrite(value);
  validateMetadata(input.kind, input.source);
  // External tools can edit metadata without a page websocket or a Vite file event.
  // Reconcile the room before comparing the caller's disk revision.
  await rooms.changed(METADATA_FILES[input.kind]);
  return rooms.coordinator.run(async () => {
    const current = await readMetadataSource(root, input.kind);
    if (current.source !== input.base) {
      throw new Error('Project settings changed. Reload before saving.');
    }
    const file = METADATA_FILES[input.kind];
    if (current.source === undefined) {
      // Exclusive creation prevents an external writer's new configuration being replaced.
      await writeFile(await preparePath(root, file), input.source, { flag: 'wx' });
    }
    const room = await rooms.get(file);
    if (current.source !== undefined && room.text.toString() !== current.source) {
      throw new Error('Project settings changed in another session. Reload before saving.');
    }
    await room.setSource(input.source);
    await room.persist();
    const saved = await readMetadataSource(root, input.kind);
    if (saved.source !== input.source) {
      throw new Error('Project settings changed during save. Reload to inspect them.');
    }
    return saved;
  });
}

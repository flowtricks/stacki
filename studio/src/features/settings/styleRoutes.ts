import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { walk, safePath, readSource } from '../project/projectServer';
import type { createRooms } from '../collaboration/rooms';
import { projectFoldersFor } from '../../../vendor/stacki/electron/lib/projectFolders';
import { folderHolding } from '../../../vendor/stacki/shared/properties/projectFolders';
import { record, sourcePath, string } from '../../shared/validation';

export async function styleFiles(root: string, astro: boolean) {
  const files = [];
  const folders = projectFoldersFor(root, 'styles');
  const paths = [...(await walk(root, 'src')), ...(astro ? [] : await walk(root, 'public'))];
  for (const file of paths) {
    if (!(astro ? /\.astro$/i.test(file) : /\.(css|scss|sass|less)$/i.test(file))) {
      continue;
    }
    // Stylesheets come from the project's style folders (.stacki/folders.json), as on Desktop.
    if (!astro && folderHolding(folders, file) === undefined) {
      continue;
    }
    const size = (await stat(await safePath(root, file))).size;
    if (astro && (size > 512 * 1024 || !/<style\b[^>]*\bis:global\b[^>]*>/i.test(await readSource(root, file)))) {
      continue;
    }
    files.push({
      rel: file,
      path: file,
      name: file.split('/').at(-1),
      size,
    });
  }
  files.sort((left, right) => (astro ? 0 : left.rel.split('/').length - right.rel.split('/').length) || left.rel.localeCompare(right.rel));
  return { files };
}
export async function saveSource(request: IncomingMessage, rooms: ReturnType<typeof createRooms>, readBody: () => Promise<string>) {
  if (request.method !== 'POST') {
    throw new Error('Use POST to save source');
  }
  const data = record(JSON.parse(await readBody()));
  const file = sourcePath(data['file']);
  const source = string(data['source']);
  const base = string(data['base']);
  const room = await rooms.get(file);
  return rooms.coordinator.run(async () => {
    if (room.text.toString() !== base) {
      throw new Error('Another editor changed this file. Reload the style panel before editing again.');
    }
    await room.setSource(source);
    return { ok: true };
  });
}

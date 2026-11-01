import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCanvasCreate, parseCanvasFile } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { preparePath, safePath } from '../project/projectServer';
import type { createRooms } from '../collaboration/rooms';

export async function defaultsCanvasRoute(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/defaults-canvas') {
    return false;
  }
  const input: unknown = JSON.parse(await readBody());
  if (request.method === 'POST') {
    const canvas = parseCanvasCreate(input);
    const absolute = await preparePath(root, canvas.file);
    if ((await readdir(path.dirname(absolute))).length >= 64) {
      throw new Error('Too many defaults previews. Close an existing preview first.');
    }
    await writeFile(absolute, canvas.source, { flag: 'wx' });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ file: canvas.file }));
  } else if (request.method === 'DELETE') {
    const canvas = parseCanvasFile(input);
    await rooms.coordinator.run(async () => {
      await rooms.remove(canvas.file);
      await rm(await safePath(root, canvas.file), { force: true });
    });
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  } else {
    throw new Error('Use POST or DELETE for a defaults canvas.');
  }
  return true;
}

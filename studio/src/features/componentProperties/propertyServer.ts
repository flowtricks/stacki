import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readComponentProperties, editPropertyDefinition } from '../../../vendor/stacki/electron/properties/propertyDefinitions';
import { planPropertyChanges } from '../../../vendor/stacki/electron/properties/propertyPlan';
import { parsePropertyChange } from '../../../vendor/stacki/shared/properties/propertyEditing';
import { err, ok } from '../../../vendor/stacki/shared/core/result';
import type { createRooms } from '../collaboration/rooms';
import { safePath } from '../project/projectServer';
import { record, sourcePath, string } from '../../shared/validation';
import { PropertyBatches, commitProperties } from './propertyBatches';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { ReferencedError } from '../../shared/referencedError';

type Rooms = ReturnType<typeof createRooms>;
export function propertyRoutes(root: string, rooms: Rooms) {
  const batches = new PropertyBatches();
  return async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>) => {
    if (pathname !== '/studio/api/component-properties') {
      return false;
    }
    const input = request.method === 'POST' ? record(JSON.parse(await readBody())) : undefined;
    const result = await rooms.coordinator.run(async () => {
      if (input) {
        return input['undo'] === undefined ? editProperties(root, rooms, batches, input) : restoreProperties(rooms, batches, string(input['undo'], 36));
      }
      if (request.method !== 'GET') {
        throw new Error('Use GET or POST for component properties');
      }
      const file = componentFile(new URL(request.url ?? '/', 'http://studio').searchParams.get('file'));
      return ok(readComponentProperties(await rooms.read(file)));
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
    return true;
  };
}
function componentFile(input: unknown) {
  const file = sourcePath(string(input, 500));
  if (!file.startsWith('src/') || file.startsWith('src/pages/') || !file.endsWith('.astro')) {
    throw new ReferencedError('props.edit.badPath');
  }
  return file;
}
async function editProperties(root: string, rooms: Rooms, batches: PropertyBatches, input: Record<string, unknown>) {
  const file = componentFile(input['file']);
  const source = string(input['source']);
  if ((await rooms.read(file)) !== source) {
    return err({ code: 'conflict', ...described('publish.studio.error.componentChanged') });
  }
  const change = parsePropertyChange(input['change']);
  const edited = editPropertyDefinition(source, change);
  if (!edited.ok) {
    return edited;
  }
  // The coordinator excludes shared writes while Stacki scans persisted draft sources.
  const absolute = await safePath(root, file);
  const plan = planPropertyChanges({ projectPath: root, file: absolute, source, change }, edited.value);
  if (!plan.ok) {
    return plan;
  }
  const changes = plan.value.map((entry) => ({
    ...entry,
    file: sourcePath(path.relative(root, entry.file).split(path.sep).join('/')),
  }));
  await commitProperties(rooms, changes);
  return ok({ ...readComponentProperties(await rooms.read(file)), undo: batches.record(changes) });
}
async function restoreProperties(rooms: Rooms, batches: PropertyBatches, token: string) {
  const changes = batches.get(token);
  await commitProperties(rooms, changes);
  batches.remove(token);
  return ok({ undo: batches.record(changes) });
}

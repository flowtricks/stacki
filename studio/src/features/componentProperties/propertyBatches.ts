import { randomUUID } from 'node:crypto';
import type { FileChange } from '../../../vendor/stacki/electron/properties/propertyPlan';
import type { createRooms } from '../collaboration/rooms';
import { sourcePath, string } from '../../shared/validation';
import { ReferencedError } from '../../shared/referencedError';

export class PropertyBatches {
  private readonly entries = new Map<string, readonly FileChange[]>();
  record(changes: readonly FileChange[]) {
    const token = randomUUID();
    this.entries.set(
      token,
      changes.map(({ file, before, after }) => ({ file, before: after, after: before })),
    );
    let size = 0;
    let count = 0;
    for (const [key, batch] of [...this.entries].reverse()) {
      count++;
      size += batch.reduce((total, change) => total + change.before.length + change.after.length, 0);
      if (size > 64 * 1024 * 1024 || count > 200) {
        this.entries.delete(key);
      }
    }
    return token;
  }
  get(token: string) {
    const changes = this.entries.get(token);
    if (!changes) {
      throw new ReferencedError('props.edit.expired');
    }
    return changes;
  }
  remove(token: string) {
    this.entries.delete(token);
  }
}

export async function commitProperties(rooms: ReturnType<typeof createRooms>, changes: readonly FileChange[]) {
  if (changes.length > 100 || new Set(changes.map(({ file }) => file)).size !== changes.length) {
    throw new ReferencedError('props.edit.batchLimit');
  }
  for (const change of changes) {
    sourcePath(change.file);
    string(change.after);
    if ((await rooms.read(change.file)) !== change.before) {
      throw new ReferencedError('props.edit.changedRefresh', { file: change.file });
    }
  }
  const targets = await Promise.all(
    changes.map(async (change) => ({
      ...change,
      room: await rooms.get(change.file),
    })),
  );
  const attempted: typeof targets = [];
  try {
    for (const target of targets) {
      attempted.push(target);
      await target.room.setSource(target.after);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const target of attempted.reverse()) {
      try {
        await target.room.setSource(target.before);
      } catch {
        failures.push(target.file);
      }
    }
    if (failures.length) {
      throw new ReferencedError('props.edit.studioRecoveryFailed', { files: failures.join(', '), detail: String(error) });
    }
    throw error;
  }
}

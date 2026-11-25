import { readFile, writeFile, rm } from 'node:fs/promises';
import { preparePath, safePath } from './projectServer';
import type { createRooms } from '../collaboration/rooms';

export interface FileChange {
  readonly file: string;
  readonly source: string;
}

// Caller holds the project coordinator. Validate every change before entering this
// function. Recovery restores prior text if a persistence operation fails.
export async function changeFiles(root: string, rooms: ReturnType<typeof createRooms>, changes: readonly FileChange[]) {
  await rooms.persist();
  const previous = await Promise.all(
    changes.map(async ({ file }) => {
      try {
        return { file, source: await readFile(await safePath(root, file), 'utf8') };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { file, source: undefined };
        }
        throw error;
      }
    }),
  );
  try {
    for (const change of changes) {
      const old = previous.find((item) => item.file === change.file);
      if (old?.source === undefined) {
        await writeFile(await preparePath(root, change.file), '', { flag: 'wx' });
      }
      await (await rooms.get(change.file)).setSource(change.source);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const old of previous) {
      try {
        if (old.source === undefined) {
          await rooms.remove(old.file);
          await rm(await safePath(root, old.file), { force: true });
        } else {
          await (await rooms.get(old.file)).setSource(old.source);
        }
      } catch (problem) {
        failures.push(problem);
      }
    }
    if (failures.length) {
      throw new Error('Storage failed during recovery. Keep the studio open; restore storage before continuing.');
    }
    throw error;
  }
}
